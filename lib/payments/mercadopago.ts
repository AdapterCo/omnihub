import { createHmac, timingSafeEqual } from 'node:crypto';
import { RuleError } from '../errors.ts';

// Cliente da API de Orders do Mercado Pago para pagamentos PRESENCIAIS, conferido na
// documentação oficial (developers/pt/reference/in-person-payments/...):
//  - Pix por QR Code dinâmico: POST /v1/orders, type "qr", config.qr.mode "dynamic",
//    config.qr.external_pos_id (caixa cadastrado na conta do lojista). A resposta traz
//    type_response.qr_data (texto EMV que NÓS transformamos em imagem). Não exige e-mail nem
//    CPF do comprador — por isso foi escolhido em vez do Pix "online" (que exige payer.email).
//  - Maquininha Point: POST /v1/orders, type "point", config.point.terminal_id (de
//    GET /terminals/v1/list; o terminal precisa estar em modo PDV).
//  - GET /v1/orders/{id}, POST /v1/orders/{id}/cancel, POST /v1/orders/{id}/refund.
//  - X-Idempotency-Key obrigatório em criação, cancelamento e estorno.
//  - Webhook: header x-signature "ts=...,v1=..." = HMAC-SHA256 (hex) com o segredo da
//    aplicação sobre "id:{data.id em minúsculas};request-id:{x-request-id};ts:{ts};".

export const MERCADO_PAGO_API = 'https://api.mercadopago.com';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

export type MpOrder = {
    id: string;
    status: string;
    statusDetail: string;
    totalAmountCents: number | null;
    qrData: string | null;
    externalReference: string;
};

/** Valor em centavos -> string com 2 casas exigida pela API ("24.00"). */
export function centsToAmount(cents: number): string {
    if (!Number.isSafeInteger(cents) || cents < 1) throw new RuleError('Valor de cobrança inválido.', 400);
    return (cents / 100).toFixed(2);
}

/** "24.00" / 24 -> 2400 centavos; null se ausente ou ilegível. */
export function amountToCents(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
}

function parseOrder(json: Record<string, unknown>): MpOrder {
    const typeResponse = (json.type_response ?? {}) as Record<string, unknown>;
    return {
        id: String(json.id ?? ''),
        status: String(json.status ?? ''),
        statusDetail: String(json.status_detail ?? ''),
        totalAmountCents: amountToCents(json.total_amount),
        qrData: typeof typeResponse.qr_data === 'string' ? typeResponse.qr_data : null,
        externalReference: String(json.external_reference ?? ''),
    };
}

/** Erro do provedor com a mensagem da API (sem o token) e se vale tentar de novo. */
export class ProviderError extends Error {
    readonly status: number;
    readonly retryable: boolean;
    constructor(message: string, status: number) {
        super(message);
        this.name = 'ProviderError';
        this.status = status;
        this.retryable = status === 0 || status === 429 || status >= 500;
    }
}

export class MercadoPagoClient {
    private readonly accessToken: string;
    private readonly fetchImpl: FetchLike;
    private readonly baseUrl: string;

    constructor(accessToken: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike, baseUrl = MERCADO_PAGO_API) {
        if (!accessToken || !accessToken.trim()) throw new RuleError('Access Token do Mercado Pago não configurado para esta loja.', 400);
        this.accessToken = accessToken.trim();
        this.fetchImpl = fetchImpl;
        this.baseUrl = baseUrl;
    }

    private async request(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
        const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' };
        if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
        let response: { status: number; text(): Promise<string> };
        try {
            response = await this.fetchImpl(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        } catch (error) {
            throw new ProviderError(`Falha de comunicação com o Mercado Pago: ${error instanceof Error ? error.message : String(error)}`, 0);
        }
        const text = await response.text();
        let json: Record<string, unknown> = {};
        try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
            json = {};
        }
        if (response.status < 200 || response.status >= 300) {
            const errors = Array.isArray(json.errors) ? (json.errors as { code?: string; message?: string }[]) : [];
            const detail = errors.map((e) => [e.code, e.message].filter(Boolean).join(': ')).join('; ') || String(json.message ?? json.error ?? text.slice(0, 200));
            throw new ProviderError(`Mercado Pago recusou a operação (HTTP ${response.status})${detail ? `: ${detail}` : ''}.`, response.status);
        }
        return json;
    }

    /** Pix por QR Code dinâmico (sem dados do comprador). */
    async createQrOrder(input: { externalReference: string; amountCents: number; externalPosId: string; description: string }, idempotencyKey: string, options: { requireQr?: boolean } = {}): Promise<MpOrder> {
        if (!input.externalPosId.trim()) throw new RuleError('Informe o identificador do caixa (external_pos_id) do Mercado Pago nas configurações de pagamento da loja.', 400);
        const amount = centsToAmount(input.amountCents);
        const order = parseOrder(
            await this.request(
                'POST',
                '/v1/orders',
                {
                    type: 'qr',
                    total_amount: amount,
                    description: input.description.slice(0, 150),
                    external_reference: input.externalReference,
                    config: { qr: { external_pos_id: input.externalPosId.trim(), mode: 'dynamic' } },
                    transactions: { payments: [{ amount }] },
                },
                idempotencyKey,
            ),
        );
        if (!order.id) throw new ProviderError('Mercado Pago não devolveu o identificador do pedido.', 502);
        // Na recuperação (mesma chave de idempotência) só interessa o id do pedido.
        if (!order.qrData && options.requireQr !== false) throw new ProviderError('Mercado Pago não devolveu o código do QR (type_response.qr_data).', 502);
        return order;
    }

    /** Cobrança enviada à maquininha Point (o cliente escolhe a forma no terminal). */
    async createPointOrder(input: { externalReference: string; amountCents: number; terminalId: string; description: string }, idempotencyKey: string): Promise<MpOrder> {
        if (!input.terminalId.trim()) throw new RuleError('Selecione a maquininha Point que vai receber a cobrança.', 400);
        const order = parseOrder(
            await this.request(
                'POST',
                '/v1/orders',
                {
                    type: 'point',
                    external_reference: input.externalReference,
                    description: input.description.slice(0, 150),
                    transactions: { payments: [{ amount: centsToAmount(input.amountCents) }] },
                    config: { point: { terminal_id: input.terminalId.trim() } },
                },
                idempotencyKey,
            ),
        );
        if (!order.id) throw new ProviderError('Mercado Pago não devolveu o identificador do pedido.', 502);
        return order;
    }

    async getOrder(orderId: string): Promise<MpOrder> {
        return parseOrder(await this.request('GET', `/v1/orders/${encodeURIComponent(orderId)}`));
    }

    async cancelOrder(orderId: string, idempotencyKey: string): Promise<MpOrder> {
        return parseOrder(await this.request('POST', `/v1/orders/${encodeURIComponent(orderId)}/cancel`, undefined, idempotencyKey));
    }

    /** Estorno TOTAL (a documentação da Point e do QR presencial só prevê estorno total). */
    async refundOrder(orderId: string, idempotencyKey: string): Promise<MpOrder> {
        return parseOrder(await this.request('POST', `/v1/orders/${encodeURIComponent(orderId)}/refund`, undefined, idempotencyKey));
    }

    async listTerminals(): Promise<{ id: string; operatingMode: string; posId: string; storeId: string }[]> {
        const json = await this.request('GET', '/terminals/v1/list?limit=50&offset=0');
        const data = (json.data ?? {}) as { terminals?: Record<string, unknown>[] };
        return (data.terminals ?? []).map((t) => ({ id: String(t.id ?? ''), operatingMode: String(t.operating_mode ?? ''), posId: String(t.pos_id ?? ''), storeId: String(t.store_id ?? '') }));
    }
}

/**
 * Valida a assinatura do webhook do Mercado Pago. Não aceita notificação sem x-signature ou
 * com v1 divergente. O manifest omite partes ausentes, conforme a documentação.
 */
export function verifyMercadoPagoSignature(params: { xSignature: string | null; xRequestId: string | null; dataId: string | null; secret: string }): boolean {
    if (!params.xSignature || !params.secret) return false;
    const parts = Object.fromEntries(
        params.xSignature.split(',').map((piece) => {
            const [key, ...rest] = piece.trim().split('=');
            return [key, rest.join('=')];
        }),
    );
    const ts = parts.ts;
    const v1 = parts.v1;
    if (!ts || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;
    let manifest = '';
    if (params.dataId) manifest += `id:${params.dataId.toLowerCase()};`;
    if (params.xRequestId) manifest += `request-id:${params.xRequestId};`;
    manifest += `ts:${ts};`;
    const expected = createHmac('sha256', params.secret).update(manifest).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(v1, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
}
