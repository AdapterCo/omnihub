import { randomBytes } from 'node:crypto';
import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import { encryptPayload, decryptPayload, type EncryptedPayload } from '../fiscal/certificate.ts';
import { applySaleStockBatch } from '../inventory/service.ts';
import { createSale, cancelSale } from '../sales/service.ts';
import type { DiscountRequest, SupervisorAuthorization } from '../sales/discount.ts';
import { recordAudit } from '../audit/service.ts';
import { logger } from '../log.ts';
import { MercadoPagoClient, ProviderError, verifyMercadoPagoSignature, type FetchLike, type MpOrder } from './mercadopago.ts';
import { qrSvg } from './qrImage.ts';

// Pagamentos integrados no PDV (Mercado Pago presencial). Princípios:
//  1. A venda nasce PENDING_PAYMENT com estoque reservado e só vira COMPLETED quando o
//     provedor confirma o pagamento do MESMO valor e da MESMA referência (external_reference).
//  2. O conteúdo do webhook nunca é confiado: ele só dispara uma consulta autenticada
//     (GET /v1/orders/{id}) com o token da própria loja. A mesma consulta é feita pela tela do
//     caixa enquanto espera e por um worker que reconcilia cobranças paradas.
//  3. Transições são "reivindicadas" atomicamente (UPDATE ... WHERE status IN (...)): webhook,
//     tela e worker podem chegar juntos, mas só um conclui/desfaz a venda.
//  4. Falha de rede na criação não perde dinheiro: a cobrança fica CREATING e o worker repete a
//     criação com a MESMA chave de idempotência (o provedor devolve o pedido já criado, se houver).
//     Como o operador recebeu erro e o QR nunca foi exibido, o pedido recuperado ainda aberto é
//     CANCELADO no provedor e a venda desfeita; se já estiver pago, a venda é concluída.

export const PROVIDER_MERCADO_PAGO = 'MERCADO_PAGO';
export type ChargeMethod = 'PIX_QR' | 'CARD_TERMINAL';
export type ChargeStatus = 'CREATING' | 'PENDING' | 'ACTION_REQUIRED' | 'PAID' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED';
const OPEN_STATUSES: ChargeStatus[] = ['CREATING', 'PENDING', 'ACTION_REQUIRED'];
const MIN_CHECK_INTERVAL_MS = 2000;
const SYSTEM_ACTOR = { userId: 'system', operator: 'Sistema (pagamento integrado)' };

export type PaymentDeps = { fetch?: FetchLike };

type ConfigRow = {
    id: string;
    tenantId: string;
    storeId: string;
    provider: string;
    accessTokenEnc: string;
    webhookSecretEnc: string | null;
    qrExternalPosId: string;
    defaultTerminalId: string;
    webhookKey: string;
    updatedAt: number;
};

type ChargeRow = {
    id: string;
    tenantId: string;
    storeId: string;
    saleId: string;
    configId: string;
    provider: string;
    method: ChargeMethod;
    amount: number;
    status: ChargeStatus;
    providerOrderId: string | null;
    providerStatus: string;
    providerStatusDetail: string;
    qrData: string | null;
    terminalId: string | null;
    error: string;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    lastCheckedAt: number;
    paidAt: number | null;
    resolutionNote: string;
};

const CONFIG_COLUMNS =
    'id, tenant_id AS tenantId, store_id AS storeId, provider, access_token_enc AS accessTokenEnc, webhook_secret_enc AS webhookSecretEnc, qr_external_pos_id AS qrExternalPosId, default_terminal_id AS defaultTerminalId, webhook_key AS webhookKey, updated_at AS updatedAt';
const CHARGE_COLUMNS =
    'id, tenant_id AS tenantId, store_id AS storeId, sale_id AS saleId, config_id AS configId, provider, method, amount, status, provider_order_id AS providerOrderId, provider_status AS providerStatus, provider_status_detail AS providerStatusDetail, qr_data AS qrData, terminal_id AS terminalId, error, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt, last_checked_at AS lastCheckedAt, paid_at AS paidAt, resolution_note AS resolutionNote';

const encryptSecret = (value: string) => JSON.stringify(encryptPayload(value));
const decryptSecret = (value: string) => {
    try {
        return decryptPayload(JSON.parse(value) as EncryptedPayload).toString('utf8');
    } catch {
        // Acontece se a FISCAL_SECRET_KEY do servidor mudou depois que a credencial foi salva.
        throw new RuleError('Não foi possível ler as credenciais de pagamento salvas desta loja (a chave FISCAL_SECRET_KEY do servidor foi alterada?). Salve o Access Token e o segredo do webhook novamente em "Pagamentos integrados".', 409);
    }
};

// ---------------------------------------------------------------- configuração por loja

export type PaymentConfigSummary = {
    storeId: string;
    provider: typeof PROVIDER_MERCADO_PAGO;
    configured: boolean;
    hasWebhookSecret: boolean;
    qrExternalPosId: string;
    defaultTerminalId: string;
    pixReady: boolean;
    terminalReady: boolean;
    webhookPath: string | null;
    updatedAt: number | null;
};

async function loadConfig(db: D1Database, tenantId: string, storeId: string): Promise<ConfigRow | null> {
    return db.prepare(`SELECT ${CONFIG_COLUMNS} FROM payment_configs WHERE tenant_id = ? AND store_id = ? AND provider = ?`).bind(tenantId, storeId, PROVIDER_MERCADO_PAGO).first<ConfigRow>();
}

function summarize(storeId: string, row: ConfigRow | null): PaymentConfigSummary {
    return {
        storeId,
        provider: PROVIDER_MERCADO_PAGO,
        configured: !!row,
        hasWebhookSecret: !!row?.webhookSecretEnc,
        qrExternalPosId: row?.qrExternalPosId ?? '',
        defaultTerminalId: row?.defaultTerminalId ?? '',
        pixReady: !!row && !!row.qrExternalPosId,
        terminalReady: !!row && !!row.defaultTerminalId,
        webhookPath: row ? `/api/payments/mercadopago/webhook/${row.webhookKey}` : null,
        updatedAt: row ? Number(row.updatedAt) : null,
    };
}

/** Resumo sem segredos. Quem vende precisa saber se Pix/maquininha estão disponíveis. */
export async function getPaymentConfigSummary(db: D1Database, tenantId: string, storeId: string): Promise<PaymentConfigSummary> {
    return summarize(storeId, await loadConfig(db, tenantId, storeId));
}

export type PaymentConfigInput = { accessToken?: string; webhookSecret?: string; qrExternalPosId: string; defaultTerminalId: string };

/**
 * Salva as credenciais do lojista. Token/segredo vazios numa atualização mantêm os atuais
 * (não é preciso redigitar); numa configuração nova o Access Token é obrigatório. Nenhum
 * valor é presumido: caixa (external_pos_id) e maquininha ficam vazios até o lojista informar.
 */
export async function savePaymentConfig(db: D1Database, tenantId: string, storeId: string, input: PaymentConfigInput, actor: Actor, now = Date.now()): Promise<PaymentConfigSummary> {
    requirePermission(actor.permissions, 'PAYMENT_CONFIG');
    const store = await db.prepare('SELECT id FROM stores WHERE id = ? AND tenant_id = ?').bind(storeId, tenantId).first<{ id: string }>();
    if (!store) throw new RuleError('Loja não encontrada.', 404);
    const token = (input.accessToken ?? '').trim();
    const secret = (input.webhookSecret ?? '').trim();
    const posId = input.qrExternalPosId.trim();
    const terminalId = input.defaultTerminalId.trim();
    if (posId && !/^[A-Za-z0-9_-]{1,64}$/.test(posId)) throw new RuleError('Identificador do caixa inválido: use só letras, números, - e _ (é o external_id do caixa no Mercado Pago).', 400);
    if (terminalId.length > 120) throw new RuleError('Identificador da maquininha inválido.', 400);
    if (token && (token.length < 20 || /\s/.test(token))) throw new RuleError('Access Token do Mercado Pago inválido.', 400);

    const existing = await loadConfig(db, tenantId, storeId);
    if (!existing) {
        if (!token) throw new RuleError('Informe o Access Token do Mercado Pago da conta desta loja.', 400);
        await db
            .prepare(
                'INSERT INTO payment_configs (id, tenant_id, store_id, provider, access_token_enc, webhook_secret_enc, qr_external_pos_id, default_terminal_id, webhook_key, updated_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            )
            .bind(crypto.randomUUID(), tenantId, storeId, PROVIDER_MERCADO_PAGO, encryptSecret(token), secret ? encryptSecret(secret) : null, posId, terminalId, randomBytes(24).toString('hex'), actor.userId, now, now)
            .run();
    } else {
        await db
            .prepare('UPDATE payment_configs SET access_token_enc = ?, webhook_secret_enc = ?, qr_external_pos_id = ?, default_terminal_id = ?, updated_by = ?, updated_at = ? WHERE id = ?')
            .bind(token ? encryptSecret(token) : existing.accessTokenEnc, secret ? encryptSecret(secret) : existing.webhookSecretEnc, posId, terminalId, actor.userId, now, existing.id)
            .run();
    }
    return getPaymentConfigSummary(db, tenantId, storeId);
}

function clientFor(config: ConfigRow, deps: PaymentDeps): MercadoPagoClient {
    return new MercadoPagoClient(decryptSecret(config.accessTokenEnc), deps.fetch);
}

/** Maquininhas Point da conta do lojista (para escolher a padrão na configuração). */
export async function listPaymentTerminals(db: D1Database, tenantId: string, storeId: string, actor: Actor, deps: PaymentDeps = {}) {
    requirePermission(actor.permissions, 'PAYMENT_CONFIG');
    const config = await loadConfig(db, tenantId, storeId);
    if (!config) throw new RuleError('Configure o Access Token do Mercado Pago desta loja primeiro.', 409);
    try {
        return await clientFor(config, deps).listTerminals();
    } catch (error) {
        throw asRuleError(error);
    }
}

function asRuleError(error: unknown): Error {
    if (error instanceof ProviderError) return new RuleError(error.message, error.status === 0 || error.status >= 500 ? 503 : 422);
    return error instanceof Error ? error : new Error(String(error));
}

// ---------------------------------------------------------------- cobranças

async function loadCharge(db: D1Database, tenantId: string, chargeId: string): Promise<ChargeRow> {
    const row = await db.prepare(`SELECT ${CHARGE_COLUMNS} FROM payment_charges WHERE id = ? AND tenant_id = ?`).bind(chargeId, tenantId).first<ChargeRow>();
    if (!row) throw new RuleError('Cobrança não encontrada.', 404);
    return row;
}

async function loadConfigById(db: D1Database, configId: string): Promise<ConfigRow> {
    const row = await db.prepare(`SELECT ${CONFIG_COLUMNS} FROM payment_configs WHERE id = ?`).bind(configId).first<ConfigRow>();
    if (!row) throw new RuleError('Configuração de pagamento da cobrança não encontrada.', 409);
    return row;
}

export type ChargeView = {
    id: string;
    saleId: string;
    method: ChargeMethod;
    amount: number;
    status: ChargeStatus;
    providerStatus: string;
    providerStatusDetail: string;
    qrData: string | null;
    qrSvg: string | null;
    terminalId: string | null;
    error: string;
    createdAt: number;
    paidAt: number | null;
};

export async function chargeView(row: ChargeRow): Promise<ChargeView> {
    const showQr = row.method === 'PIX_QR' && (row.status === 'PENDING' || row.status === 'CREATING');
    return {
        id: row.id,
        saleId: row.saleId,
        method: row.method,
        amount: Number(row.amount),
        status: row.status,
        providerStatus: row.providerStatus,
        providerStatusDetail: row.providerStatusDetail,
        qrData: showQr ? row.qrData : null,
        qrSvg: showQr ? await qrSvg(row.qrData) : null,
        terminalId: row.terminalId,
        error: row.error,
        createdAt: Number(row.createdAt),
        paidAt: row.paidAt === null ? null : Number(row.paidAt),
    };
}

export async function getChargeView(db: D1Database, tenantId: string, chargeId: string, actor: Actor): Promise<ChargeView> {
    const row = await loadCharge(db, tenantId, chargeId);
    requireStoreAccess(actor, row.storeId);
    return chargeView(row);
}

export type StartChargeInput = {
    storeId: string;
    items: { productId: string; qty: number }[];
    customer: string;
    document: string;
    discount?: DiscountRequest;
    authorization?: SupervisorAuthorization;
    method: ChargeMethod;
    terminalId?: string;
};

/**
 * Cria a venda PENDING_PAYMENT (mesmas regras de preço, estoque, desconto e caixa aberto de
 * uma venda comum) e a cobrança no provedor pelo valor líquido calculado no servidor.
 */
export async function startCharge(db: D1Database, tenantId: string, input: StartChargeInput, actor: Actor, now = Date.now(), deps: PaymentDeps = {}): Promise<ChargeView> {
    requirePermission(actor.permissions, 'SALE_CREATE');
    const config = await loadConfig(db, tenantId, input.storeId);
    if (!config) throw new RuleError('Pagamento integrado não configurado para esta loja (Minhas lojas > Pagamentos integrados).', 409);
    const terminalId = (input.terminalId ?? config.defaultTerminalId).trim();
    if (input.method === 'PIX_QR' && !config.qrExternalPosId) throw new RuleError('Informe o caixa do Mercado Pago (external_pos_id) nas configurações de pagamento da loja para cobrar Pix.', 409);
    if (input.method === 'CARD_TERMINAL' && !terminalId) throw new RuleError('Nenhuma maquininha Point configurada para esta loja.', 409);

    const saleId = await createSale(
        db,
        tenantId,
        {
            storeId: input.storeId,
            items: input.items,
            customer: input.customer,
            document: input.document,
            payment: input.method === 'PIX_QR' ? 'Pix' : 'Cartão',
            discount: input.discount,
            authorization: input.authorization,
        },
        actor,
        now,
        { pendingPayment: true },
    );
    const sale = await db.prepare('SELECT total FROM sales WHERE id = ?').bind(saleId).first<{ total: number }>();
    const amount = Number(sale?.total);
    const chargeId = crypto.randomUUID();
    await db
        .prepare(
            'INSERT INTO payment_charges (id, tenant_id, store_id, sale_id, config_id, provider, method, amount, status, terminal_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(chargeId, tenantId, input.storeId, saleId, config.id, PROVIDER_MERCADO_PAGO, input.method, amount, 'CREATING', input.method === 'CARD_TERMINAL' ? terminalId : null, actor.userId, now, now)
        .run();

    try {
        const order = await createProviderOrder(config, { id: chargeId, saleId, method: input.method, amount, terminalId }, deps);
        await db
            .prepare("UPDATE payment_charges SET status = 'PENDING', provider_order_id = ?, provider_status = ?, provider_status_detail = ?, qr_data = ?, updated_at = ?, last_checked_at = ? WHERE id = ? AND status = 'CREATING'")
            .bind(order.id, order.status, order.statusDetail, order.qrData, now, now, chargeId)
            .run();
    } catch (error) {
        if (error instanceof ProviderError && error.retryable) {
            // Não sabemos se o pedido foi criado: o worker repete a criação com a mesma chave de
            // idempotência e cancela/conclui. A venda continua reservada até lá.
            await db.prepare('UPDATE payment_charges SET error = ?, updated_at = ? WHERE id = ?').bind(error.message.slice(0, 500), now, chargeId).run();
            logger.warn('payment.criacao_incerta', { chargeId, error });
            throw new RuleError('Falha de comunicação com o Mercado Pago ao criar a cobrança. Não cobre esta tentativa: ela será cancelada automaticamente em instantes (a venda reservada é desfeita). Tente cobrar de novo.', 503);
        }
        // Recusa definitiva (dados inválidos, credencial errada): nada foi cobrado, desfaz a venda.
        const message = error instanceof Error ? error.message : String(error);
        await finalizeCharge(db, await loadCharge(db, tenantId, chargeId), 'FAILED', { providerStatus: 'rejected', providerStatusDetail: '', error: message.slice(0, 500) }, now);
        throw asRuleError(error);
    }
    return chargeView(await loadCharge(db, tenantId, chargeId));
}

async function createProviderOrder(config: ConfigRow, charge: { id: string; saleId: string; method: ChargeMethod; amount: number; terminalId: string | null }, deps: PaymentDeps, recovery = false): Promise<MpOrder> {
    const client = clientFor(config, deps);
    const description = `Venda ${charge.saleId.slice(0, 8).toUpperCase()}`;
    // external_reference e X-Idempotency-Key = id da cobrança: sem dado pessoal, único, e repetir
    // a criação devolve o MESMO pedido (base da recuperação de falhas de rede).
    return charge.method === 'PIX_QR'
        ? client.createQrOrder({ externalReference: charge.id, amountCents: charge.amount, externalPosId: config.qrExternalPosId, description }, charge.id, { requireQr: !recovery })
        : client.createPointOrder({ externalReference: charge.id, amountCents: charge.amount, terminalId: charge.terminalId ?? '', description }, charge.id);
}

/** Traduz o status do pedido do Mercado Pago (Orders presencial) para o status da cobrança. */
export function mapOrderStatus(order: MpOrder): ChargeStatus {
    switch (order.status) {
        case 'created':
        case 'at_terminal':
            return 'PENDING';
        case 'processed':
            return 'PAID';
        case 'action_required':
            return 'ACTION_REQUIRED';
        case 'failed':
            return 'FAILED';
        case 'canceled':
            return 'CANCELLED';
        case 'expired':
            return 'EXPIRED';
        case 'refunded':
            return 'REFUNDED';
        default:
            return 'ACTION_REQUIRED';
    }
}

/**
 * Leva a cobrança ao status final e ajusta a venda. Só quem "reivindica" a transição (status
 * ainda aberto) mexe na venda; chamadas concorrentes viram no-op.
 */
async function finalizeCharge(
    db: D1Database,
    charge: ChargeRow,
    status: 'PAID' | 'FAILED' | 'CANCELLED' | 'EXPIRED',
    info: { providerStatus: string; providerStatusDetail: string; error?: string; resolvedBy?: string; resolutionNote?: string },
    now: number,
): Promise<boolean> {
    const claim = await db
        .prepare(
            `UPDATE payment_charges SET status = ?, provider_status = ?, provider_status_detail = ?, error = ?, resolved_by = COALESCE(?, resolved_by), resolution_note = CASE WHEN ? = '' THEN resolution_note ELSE ? END, paid_at = ?, updated_at = ?, last_checked_at = ?
             WHERE id = ? AND status IN ('CREATING', 'PENDING', 'ACTION_REQUIRED')`,
        )
        .bind(status, info.providerStatus, info.providerStatusDetail, info.error ?? '', info.resolvedBy ?? null, info.resolutionNote ?? '', info.resolutionNote ?? '', status === 'PAID' ? now : null, now, now, charge.id)
        .run();
    if (claim.meta.changes !== 1) return false;

    if (status === 'PAID') {
        await db.prepare("UPDATE sales SET status = 'COMPLETED' WHERE id = ? AND status = 'PENDING_PAYMENT'").bind(charge.saleId).run();
    } else {
        const voided = await db.prepare("UPDATE sales SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING_PAYMENT'").bind(charge.saleId).run();
        if (voided.meta.changes === 1) {
            const items = await db.prepare('SELECT product_id AS productId, qty FROM sale_items WHERE sale_id = ?').bind(charge.saleId).all<{ productId: string; qty: number }>();
            await applySaleStockBatch(db, charge.tenantId, (items.results ?? []).map((i) => ({ storeId: charge.storeId, productId: i.productId, qty: Number(i.qty) })), info.resolvedBy ?? SYSTEM_ACTOR.userId, charge.saleId, { reverse: true }, now);
        }
    }
    await recordAudit(
        db,
        {
            tenantId: charge.tenantId,
            storeId: charge.storeId,
            userId: info.resolvedBy ?? SYSTEM_ACTOR.userId,
            operator: info.resolvedBy ? 'Resolução manual' : SYSTEM_ACTOR.operator,
            action: 'payment.charge.' + status.toLowerCase(),
            description: `Cobrança ${charge.method === 'PIX_QR' ? 'Pix' : 'maquininha'} da venda ${charge.saleId.slice(0, 8)}: ${status}${info.resolutionNote ? ` (${info.resolutionNote})` : ''}`,
            entity: 'payment_charge',
            entityId: charge.id,
            after: { status, providerStatus: info.providerStatus, providerStatusDetail: info.providerStatusDetail, amount: Number(charge.amount), error: info.error ?? '' },
        },
        now,
    );
    return true;
}

/** Aplica o pedido consultado no provedor à cobrança, com as verificações de integridade. */
async function applyOrder(db: D1Database, charge: ChargeRow, order: MpOrder, now: number): Promise<void> {
    const mapped = mapOrderStatus(order);
    if (mapped === 'PAID') {
        // Pagamento só conta se for do nosso pedido e do valor cobrado.
        const sameReference = !order.externalReference || order.externalReference === charge.id;
        if (order.totalAmountCents !== Number(charge.amount) || !sameReference) {
            await db
                .prepare("UPDATE payment_charges SET status = 'ACTION_REQUIRED', provider_status = ?, provider_status_detail = ?, error = ?, updated_at = ?, last_checked_at = ? WHERE id = ? AND status IN ('CREATING','PENDING','ACTION_REQUIRED')")
                .bind(order.status, order.statusDetail, `Pagamento informado pelo provedor não confere (valor ${order.totalAmountCents ?? '?'} x cobrado ${charge.amount}; referência ${order.externalReference || '-'}). Verifique no Mercado Pago.`, now, now, charge.id)
                .run();
            logger.error('payment.valor_divergente', { chargeId: charge.id, esperado: Number(charge.amount), recebido: order.totalAmountCents });
            return;
        }
        await finalizeCharge(db, charge, 'PAID', { providerStatus: order.status, providerStatusDetail: order.statusDetail }, now);
        return;
    }
    if (mapped === 'FAILED' || mapped === 'CANCELLED' || mapped === 'EXPIRED') {
        await finalizeCharge(db, charge, mapped, { providerStatus: order.status, providerStatusDetail: order.statusDetail }, now);
        return;
    }
    if (mapped === 'REFUNDED') {
        // Estorno feito fora do sistema (ex.: na maquininha). Registra, mas não desfaz a venda
        // sozinho: a mercadoria já saiu — o gerente decide (cancelar a venda ou não).
        await db
            .prepare("UPDATE payment_charges SET status = 'REFUNDED', provider_status = ?, provider_status_detail = ?, error = ?, updated_at = ?, last_checked_at = ? WHERE id = ? AND status <> 'REFUNDED'")
            .bind(order.status, order.statusDetail, 'Estornado no Mercado Pago fora do sistema. Confira a venda.', now, now, charge.id)
            .run();
        return;
    }
    await db
        .prepare("UPDATE payment_charges SET status = ?, provider_status = ?, provider_status_detail = ?, updated_at = ?, last_checked_at = ? WHERE id = ? AND status IN ('CREATING','PENDING','ACTION_REQUIRED')")
        .bind(mapped, order.status, order.statusDetail, now, now, charge.id)
        .run();
}

/** Consulta o provedor e aplica o resultado (usado pela tela, pelo webhook e pelo worker). */
async function syncCharge(db: D1Database, charge: ChargeRow, now: number, deps: PaymentDeps): Promise<void> {
    const config = await loadConfigById(db, charge.configId);
    if (charge.status === 'CREATING' || !charge.providerOrderId) {
        // Recupera a criação incerta repetindo-a com a mesma chave de idempotência. O operador já
        // recebeu erro e o QR nunca foi exibido: se o pedido existe e está aberto, cancela.
        const created = await createProviderOrder(config, { id: charge.id, saleId: charge.saleId, method: charge.method, amount: Number(charge.amount), terminalId: charge.terminalId }, deps, true);
        await db.prepare('UPDATE payment_charges SET provider_order_id = ?, updated_at = ? WHERE id = ?').bind(created.id, now, charge.id).run();
        charge = await loadCharge(db, charge.tenantId, charge.id);
        const current = await clientFor(config, deps).getOrder(created.id);
        if (current.status === 'created') {
            try {
                const cancelled = await clientFor(config, deps).cancelOrder(created.id, `${charge.id}-cancel`);
                await applyOrder(db, charge, cancelled.status ? cancelled : { ...cancelled, status: 'canceled' }, now);
                return;
            } catch (error) {
                if (!(error instanceof ProviderError && error.status === 409)) throw error;
                // Conflito: o pedido andou (ex.: chegou à maquininha). Segue o status real abaixo.
            }
        }
        await applyOrder(db, charge, await clientFor(config, deps).getOrder(created.id), now);
        return;
    }
    const order = await clientFor(config, deps).getOrder(charge.providerOrderId as string);
    await applyOrder(db, charge, order, now);
}

export async function refreshCharge(db: D1Database, tenantId: string, chargeId: string, actor: Actor, now = Date.now(), deps: PaymentDeps = {}): Promise<ChargeView> {
    let charge = await loadCharge(db, tenantId, chargeId);
    requireStoreAccess(actor, charge.storeId);
    if (OPEN_STATUSES.includes(charge.status) && now - Number(charge.lastCheckedAt) >= MIN_CHECK_INTERVAL_MS) {
        await db.prepare('UPDATE payment_charges SET last_checked_at = ? WHERE id = ?').bind(now, chargeId).run();
        try {
            await syncCharge(db, charge, now, deps);
        } catch (error) {
            // A tela continua esperando; o erro fica visível mas não muda o status.
            await db.prepare('UPDATE payment_charges SET error = ? WHERE id = ?').bind((error instanceof Error ? error.message : String(error)).slice(0, 500), chargeId).run();
        }
        charge = await loadCharge(db, tenantId, chargeId);
    }
    return chargeView(charge);
}

/** Cancela a cobrança em aberto no provedor e devolve o estoque da venda reservada. */
export async function cancelCharge(db: D1Database, tenantId: string, chargeId: string, actor: Actor, now = Date.now(), deps: PaymentDeps = {}): Promise<ChargeView> {
    requirePermission(actor.permissions, 'SALE_CREATE');
    const charge = await loadCharge(db, tenantId, chargeId);
    requireStoreAccess(actor, charge.storeId);
    if (!OPEN_STATUSES.includes(charge.status)) throw new RuleError('Esta cobrança já foi finalizada.', 409);
    if (charge.status === 'ACTION_REQUIRED') throw new RuleError('A maquininha pediu conferência do pagamento. Verifique no terminal e use "Resolver cobrança".', 409);
    const config = await loadConfigById(db, charge.configId);
    try {
        if (charge.providerOrderId) {
            const order = await clientFor(config, deps).cancelOrder(charge.providerOrderId, `${charge.id}-cancel`);
            await applyOrder(db, charge, order.status ? order : { ...order, status: 'canceled' }, now);
        } else {
            await syncCharge(db, charge, now, deps);
            const again = await loadCharge(db, tenantId, chargeId);
            if (again.providerOrderId && OPEN_STATUSES.includes(again.status)) {
                const order = await clientFor(config, deps).cancelOrder(again.providerOrderId, `${again.id}-cancel`);
                await applyOrder(db, again, order.status ? order : { ...order, status: 'canceled' }, now);
            }
        }
    } catch (error) {
        if (error instanceof ProviderError && error.status === 409) {
            // Conflito típico: pedido já na maquininha (at_terminal) ou já pago. Consulta e aplica.
            await syncCharge(db, charge, now, deps).catch(() => undefined);
            const after = await loadCharge(db, tenantId, chargeId);
            if (OPEN_STATUSES.includes(after.status)) throw new RuleError('A cobrança já está na maquininha: cancele pelo próprio terminal.', 409);
            return chargeView(after);
        }
        throw asRuleError(error);
    }
    return chargeView(await loadCharge(db, tenantId, chargeId));
}

/**
 * "Verificar no terminal" (action_required): o Mercado Pago avisa que esse status não muda
 * sozinho. Primeiro consulta de novo; se continuar pendente, uma pessoa com PAYMENT_RESOLVE
 * decide olhando a maquininha, com justificativa registrada.
 */
export async function resolveCharge(db: D1Database, tenantId: string, chargeId: string, outcome: 'PAID' | 'NOT_PAID', note: string, actor: Actor, now = Date.now(), deps: PaymentDeps = {}): Promise<ChargeView> {
    requirePermission(actor.permissions, 'PAYMENT_RESOLVE');
    let charge = await loadCharge(db, tenantId, chargeId);
    requireStoreAccess(actor, charge.storeId);
    if (charge.status !== 'ACTION_REQUIRED') throw new RuleError('Só cobranças em "verificar no terminal" podem ser resolvidas manualmente.', 409);
    if (!note || note.trim().length < 10) throw new RuleError('Descreva o que foi conferido no terminal (mín. 10 caracteres).', 400);
    await syncCharge(db, charge, now, deps).catch(() => undefined);
    charge = await loadCharge(db, tenantId, chargeId);
    if (charge.status !== 'ACTION_REQUIRED') return chargeView(charge);
    await finalizeCharge(db, charge, outcome === 'PAID' ? 'PAID' : 'FAILED', { providerStatus: charge.providerStatus, providerStatusDetail: charge.providerStatusDetail, error: charge.error, resolvedBy: actor.userId, resolutionNote: note.trim() }, now);
    return chargeView(await loadCharge(db, tenantId, chargeId));
}

/**
 * Cancelamento de venda paga por pagamento integrado: estorno TOTAL no provedor primeiro
 * (única forma prevista para QR presencial e Point); só depois a venda é cancelada.
 */
export async function cancelSaleWithRefund(db: D1Database, tenantId: string, saleId: string, actor: Actor, now = Date.now(), deps: PaymentDeps = {}): Promise<boolean> {
    const charge = await db.prepare(`SELECT ${CHARGE_COLUMNS} FROM payment_charges WHERE sale_id = ? AND tenant_id = ?`).bind(saleId, tenantId).first<ChargeRow>();
    if (!charge || (charge.status !== 'PAID' && charge.status !== 'REFUNDED')) return false;
    requirePermission(actor.permissions, 'SALE_CANCEL');
    requireStoreAccess(actor, charge.storeId);
    if (charge.status === 'PAID') {
        const config = await loadConfigById(db, charge.configId);
        let order: MpOrder;
        try {
            order = await clientFor(config, deps).refundOrder(charge.providerOrderId as string, `${charge.id}-refund`);
        } catch (error) {
            throw asRuleError(error);
        }
        await db.prepare("UPDATE payment_charges SET status = 'REFUNDED', provider_status = ?, provider_status_detail = ?, updated_at = ? WHERE id = ? AND status = 'PAID'").bind(order.status || 'refunded', order.statusDetail, now, charge.id).run();
    }
    await cancelSale(db, tenantId, saleId, actor, now, { providerRefunded: true });
    return true;
}

// ---------------------------------------------------------------- webhook e worker

/**
 * Webhook do Mercado Pago. Valida a assinatura com o segredo da loja (pela webhook_key da
 * URL) e usa a notificação só como gatilho para consultar o pedido. Retorna o status HTTP.
 */
export async function handleMercadoPagoWebhook(
    db: D1Database,
    webhookKey: string,
    // dataId: data.id da URL (entra na assinatura); lookupId: id usado para achar o pedido (URL ou corpo).
    request: { xSignature: string | null; xRequestId: string | null; dataId: string | null; lookupId?: string | null },
    now = Date.now(),
    deps: PaymentDeps = {},
): Promise<number> {
    if (!/^[a-f0-9]{48}$/.test(webhookKey)) return 404;
    const config = await db.prepare(`SELECT ${CONFIG_COLUMNS} FROM payment_configs WHERE webhook_key = ?`).bind(webhookKey).first<ConfigRow>();
    if (!config) return 404;
    if (!config.webhookSecretEnc) {
        logger.warn('payment.webhook.sem_segredo', { storeId: config.storeId });
        return 401;
    }
    const valid = verifyMercadoPagoSignature({ xSignature: request.xSignature, xRequestId: request.xRequestId, dataId: request.dataId, secret: decryptSecret(config.webhookSecretEnc) });
    if (!valid) {
        logger.warn('payment.webhook.assinatura_invalida', { storeId: config.storeId });
        return 401;
    }
    const orderId = request.lookupId ?? request.dataId;
    if (!orderId) return 200;
    const charge = await db.prepare(`SELECT ${CHARGE_COLUMNS} FROM payment_charges WHERE provider_order_id = ? AND config_id = ?`).bind(orderId, config.id).first<ChargeRow>();
    if (!charge) return 200; // pedido que não é nosso (ou já antigo): nada a fazer
    try {
        await syncCharge(db, charge, now, deps);
    } catch (error) {
        logger.error('payment.webhook.falha_consulta', { chargeId: charge.id, error });
        return 500; // o Mercado Pago reenvia; o worker também reconcilia
    }
    return 200;
}

/** Reconcilia cobranças abertas (tela fechada, webhook perdido, criação incerta). */
export async function reconcileOpenCharges(db: D1Database, now = Date.now(), deps: PaymentDeps = {}, limit = 25): Promise<{ checked: number; failed: number }> {
    const rows = await db
        .prepare(`SELECT ${CHARGE_COLUMNS} FROM payment_charges WHERE status IN ('CREATING','PENDING') AND last_checked_at < ? ORDER BY last_checked_at LIMIT ?`)
        .bind(now - 15000, limit)
        .all<ChargeRow>();
    let checked = 0;
    let failed = 0;
    for (const charge of rows.results ?? []) {
        checked += 1;
        await db.prepare('UPDATE payment_charges SET last_checked_at = ? WHERE id = ?').bind(now, charge.id).run();
        try {
            await syncCharge(db, charge, now, deps);
        } catch (error) {
            failed += 1;
            logger.warn('payment.reconciliacao.falhou', { chargeId: charge.id, error });
        }
    }
    return { checked, failed };
}

/** Cobranças abertas da loja (a tela do caixa retoma a espera depois de recarregar). */
export async function listOpenCharges(db: D1Database, tenantId: string): Promise<ChargeView[]> {
    const rows = await db
        .prepare(`SELECT ${CHARGE_COLUMNS} FROM payment_charges WHERE tenant_id = ? AND (status IN ('CREATING','PENDING','ACTION_REQUIRED') OR (status = 'REFUNDED' AND error <> '')) ORDER BY created_at DESC LIMIT 50`)
        .bind(tenantId)
        .all<ChargeRow>();
    return Promise.all((rows.results ?? []).map((r) => chargeView(r)));
}
