import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { registerAccount, hashPassword } from '../lib/auth/service.ts';
import { loadPermissions } from '../lib/authz/service.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { cancelSale } from '../lib/sales/service.ts';
import { returnSale } from '../lib/sales/returns.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import { generateNFeForSale } from '../lib/fiscal/service.ts';
import { getSalesReport } from '../lib/reports/service.ts';
import { centsToAmount, amountToCents, verifyMercadoPagoSignature, MercadoPagoClient, type FetchLike } from '../lib/payments/mercadopago.ts';
import {
    savePaymentConfig,
    getPaymentConfigSummary,
    startCharge,
    refreshCharge,
    cancelCharge,
    resolveCharge,
    reconcileOpenCharges,
    handleMercadoPagoWebhook,
    mapOrderStatus,
} from '../lib/payments/service.ts';
import type { Actor } from '../lib/domain.ts';

// Chave de criptografia SÓ de teste (mesmo padrão dos testes fiscais).
process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';

const PASSWORD = 'senha-forte-123';
const TOKEN = 'APP_USR-0000000000000000-000000-teste-somente'; // MOCK: token fictício, nunca real
const WEBHOOK_SECRET = 'segredo-webhook-de-teste-0123456789'; // MOCK
const plan = { status: 'active', accessUntil: 9_999_999_999_999, maxStores: 3 };

/**
 * MOCK do Mercado Pago (só em teste): implementa em memória o comportamento documentado da API
 * de Orders presencial — criação idempotente pela X-Idempotency-Key (mesma chave devolve o mesmo
 * pedido), consulta, cancelamento (só em "created") e estorno (só em "processed"). O teste
 * controla o status e injeta falhas. Nenhuma chamada sai para a internet.
 */
function createMercadoPagoMock() {
    type Order = { id: string; type: string; status: string; status_detail: string; total_amount: string; external_reference: string; qr_data?: string; terminal_id?: string };
    const orders = new Map<string, Order>();
    const byKey = new Map<string, string>();
    const calls: { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = [];
    let seq = 0;
    let nextFailure: { kind: 'network' } | { kind: 'http'; status: number; body: unknown } | null = null;
    let createCount = 0;

    const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    const fetch: FetchLike = async (url, init) => {
        const path = url.replace('https://api.mercadopago.com', '');
        const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        calls.push({ method: init.method, path, headers: init.headers, body });
        if (nextFailure) {
            const failure = nextFailure;
            nextFailure = null;
            if (failure.kind === 'network') throw new Error('ECONNRESET (simulado)');
            return reply(failure.status, failure.body);
        }
        if (init.headers.Authorization !== `Bearer ${TOKEN}`) return reply(401, { errors: [{ code: 'unauthorized', message: 'invalid token' }] });
        if (init.method === 'POST' && path === '/v1/orders') {
            const key = init.headers['X-Idempotency-Key'];
            if (!key) return reply(400, { errors: [{ code: 'empty_required_header' }] });
            const known = byKey.get(key);
            if (known) return reply(201, orders.get(known));
            createCount += 1;
            const id = `ORD${String(++seq).padStart(26, '0')}`;
            const payments = (body?.transactions as { payments: { amount: string }[] }).payments;
            const order: Order = {
                id,
                type: String(body?.type),
                status: 'created',
                status_detail: 'created',
                total_amount: String(body?.total_amount ?? payments[0].amount),
                external_reference: String(body?.external_reference),
            };
            if (body?.type === 'qr') order.qr_data = `00020101021226...MOCK...${id}`;
            if (body?.type === 'point') order.terminal_id = String((body?.config as { point: { terminal_id: string } }).point.terminal_id);
            orders.set(id, order);
            byKey.set(key, id);
            const { qr_data, ...rest } = order;
            return reply(201, { ...rest, ...(qr_data ? { type_response: { qr_data } } : {}) });
        }
        const match = /^\/v1\/orders\/([^/]+)(?:\/(cancel|refund))?$/.exec(path);
        if (match) {
            const order = orders.get(decodeURIComponent(match[1]));
            if (!order) return reply(404, { errors: [{ code: 'order_not_found' }] });
            if (match[2] === 'cancel') {
                if (order.status !== 'created') return reply(409, { errors: [{ code: 'order_already_canceled', message: 'status inválido para cancelar' }] });
                order.status = 'canceled';
                order.status_detail = 'canceled';
            }
            if (match[2] === 'refund') {
                if (order.status !== 'processed') return reply(409, { errors: [{ code: 'invalid_status' }] });
                order.status = 'refunded';
                order.status_detail = 'refunded';
            }
            return reply(200, order);
        }
        if (path.startsWith('/terminals/v1/list')) return reply(200, { data: { terminals: [{ id: 'NEWLAND_N950__N950NCB801293324', pos_id: '1', store_id: '1', operating_mode: 'PDV' }] } });
        return reply(404, {});
    };
    return {
        fetch,
        calls,
        orders,
        get createCount() {
            return createCount;
        },
        set: (id: string, status: string, patch: Partial<Order> = {}) => Object.assign(orders.get(id) as Order, { status, status_detail: status }, patch),
        failNext: (failure: typeof nextFailure) => {
            nextFailure = failure;
        },
    };
}

async function addMember(db: D1Database, tenantId: string, opts: { email: string; roleId: string; legacyRole: string; name: string }) {
    const userId = crypto.randomUUID();
    await db.prepare('INSERT INTO users (id, display_name, email, password_hash, created_at) VALUES (?,?,?,?,?)').bind(userId, opts.name, opts.email, await hashPassword(PASSWORD), 1).run();
    await db.prepare('INSERT INTO memberships (user_id, account_id, role, store_id, display_name) VALUES (?,?,?,NULL,?)').bind(userId, tenantId, opts.legacyRole, opts.name).run();
    await db.prepare('INSERT INTO user_tenant_roles (id, user_id, tenant_id, role_id) VALUES (?,?,?,?)').bind(crypto.randomUUID(), userId, tenantId, opts.roleId).run();
    return userId;
}
async function actorFor(db: D1Database, tenantId: string, userId: string, legacyRole: string, name: string, storeId: string | null = null): Promise<Actor> {
    return { userId, displayName: name, role: legacyRole, storeId, permissions: await loadPermissions(db, userId, tenantId, legacyRole) };
}

async function fixture(options: { configure?: boolean; posId?: string; terminal?: string; secret?: string | null } = {}) {
    const db = createFakeD1();
    const mp = createMercadoPagoMock();
    const deps = { fetch: mp.fetch };
    const reg = await registerAccount(db, { accountName: 'Grupo Teste', displayName: 'Dona Ana', email: 'ana@teste.com', password: PASSWORD });
    const tenantId = reg.accountId;
    const owner = await actorFor(db, tenantId, reg.userId, 'admin', 'Dona Ana');
    const storeId = await createStore(db, tenantId, { name: 'Loja Centro' } as never, owner);
    const productId = await createProduct(db, tenantId, { name: 'Camiseta', sku: 'CAM-1', price: 5000, cost: 2000, minimum: 1, unit: 'UN' } as never, owner);
    await receiveStock(db, { tenantId, storeId, productId, quantity: 10, userId: reg.userId, reason: 'Estoque inicial' }, owner);
    const operatorId = await addMember(db, tenantId, { email: 'op@teste.com', roleId: 'ROLE_OPERADOR_CAIXA', legacyRole: 'operator', name: 'Operador Beto' });
    const managerId = await addMember(db, tenantId, { email: 'gerente@teste.com', roleId: 'ROLE_GERENTE', legacyRole: 'operator', name: 'Gerente Carla' });
    const operator = await actorFor(db, tenantId, operatorId, 'operator', 'Operador Beto', storeId);
    const manager = await actorFor(db, tenantId, managerId, 'operator', 'Gerente Carla', storeId);
    const ownerAtStore = await actorFor(db, tenantId, reg.userId, 'admin', 'Dona Ana', storeId);
    await openSession(db, tenantId, storeId, 0, operator);
    if (options.configure !== false) {
        await savePaymentConfig(db, tenantId, storeId, { accessToken: TOKEN, webhookSecret: options.secret === null ? '' : (options.secret ?? WEBHOOK_SECRET), qrExternalPosId: options.posId ?? 'LOJA1CAIXA1', defaultTerminalId: options.terminal ?? 'NEWLAND_N950__N950NCB801293324' }, owner);
    }
    const stock = async () => Number((await db.prepare('SELECT quantity FROM inventories WHERE store_id = ? AND product_id = ?').bind(storeId, productId).first<{ quantity: number }>())?.quantity);
    const sale = (id: string) => db.prepare('SELECT status, total FROM sales WHERE id = ?').bind(id).first<{ status: string; total: number }>();
    const chargeRow = (id: string) => db.prepare('SELECT status, provider_order_id AS orderId, error FROM payment_charges WHERE id = ?').bind(id).first<{ status: string; orderId: string; error: string }>();
    const start = (method: 'PIX_QR' | 'CARD_TERMINAL' = 'PIX_QR', extra: Record<string, unknown> = {}, now = Date.now()) =>
        startCharge(db, tenantId, { storeId, items: [{ productId, qty: 2 }], customer: '', document: '', method, ...extra }, operator, now, deps);
    return { db, mp, deps, tenantId, storeId, productId, owner, ownerAtStore, operator, manager, stock, sale, chargeRow, start };
}

test('cliente: valores em string com 2 casas, leitura de centavos e mapa de status documentado', () => {
    assert.equal(centsToAmount(10000), '100.00');
    assert.equal(centsToAmount(1), '0.01');
    assert.throws(() => centsToAmount(0));
    assert.equal(amountToCents('24.00'), 2400);
    assert.equal(amountToCents(24.5), 2450);
    assert.equal(amountToCents(''), null);
    const m = (status: string) => mapOrderStatus({ id: 'x', status, statusDetail: '', totalAmountCents: 1, qrData: null, externalReference: '' });
    assert.deepEqual(['created', 'at_terminal', 'processed', 'action_required', 'failed', 'canceled', 'expired', 'refunded', 'desconhecido'].map(m), ['PENDING', 'PENDING', 'PAID', 'ACTION_REQUIRED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'ACTION_REQUIRED']);
});

test('cliente: pedido Pix presencial é type qr, modo dinâmico, com caixa, idempotência e SEM e-mail do comprador', async () => {
    const mp = createMercadoPagoMock();
    const client = new MercadoPagoClient(TOKEN, mp.fetch);
    const order = await client.createQrOrder({ externalReference: 'ref-1', amountCents: 12345, externalPosId: 'LOJA1CAIXA1', description: 'Venda X' }, 'chave-1');
    const call = mp.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/v1/orders');
    assert.equal(call.headers['X-Idempotency-Key'], 'chave-1');
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(call.body?.config, { qr: { external_pos_id: 'LOJA1CAIXA1', mode: 'dynamic' } });
    assert.equal(call.body?.total_amount, '123.45');
    assert.equal(call.body?.type, 'qr');
    assert.ok(!('payer' in (call.body ?? {})), 'não envia payer (nem e-mail inventado)');
    assert.ok(order.qrData);
    await assert.rejects(() => client.createQrOrder({ externalReference: 'r', amountCents: 1, externalPosId: '', description: '' }, 'k'), /external_pos_id/);
    assert.throws(() => new MercadoPagoClient('  ', mp.fetch), /Access Token/);
});

test('assinatura do webhook: aceita só o HMAC correto do manifest documentado', () => {
    const ts = '1742505638683';
    const manifest = `id:ord01jq4s4ky8hwq6na5pxb65b3d3;request-id:req-123;ts:${ts};`;
    const v1 = createHmac('sha256', WEBHOOK_SECRET).update(manifest).digest('hex');
    const ok = { xSignature: `ts=${ts},v1=${v1}`, xRequestId: 'req-123', dataId: 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3', secret: WEBHOOK_SECRET };
    assert.equal(verifyMercadoPagoSignature(ok), true, 'data.id é convertido para minúsculas');
    assert.equal(verifyMercadoPagoSignature({ ...ok, secret: 'outro-segredo' }), false);
    assert.equal(verifyMercadoPagoSignature({ ...ok, xRequestId: 'req-999' }), false);
    assert.equal(verifyMercadoPagoSignature({ ...ok, xSignature: null }), false);
    assert.equal(verifyMercadoPagoSignature({ ...ok, xSignature: `ts=${ts},v1=zz` }), false);
    // parte ausente sai do manifest
    const noId = createHmac('sha256', WEBHOOK_SECRET).update(`request-id:req-123;ts:${ts};`).digest('hex');
    assert.equal(verifyMercadoPagoSignature({ ...ok, dataId: null, xSignature: `ts=${ts},v1=${noId}` }), true);
});

test('configuração: só PAYMENT_CONFIG; token obrigatório na criação; segredos criptografados e nunca expostos', async () => {
    const f = await fixture({ configure: false });
    await assert.rejects(() => savePaymentConfig(f.db, f.tenantId, f.storeId, { accessToken: TOKEN, qrExternalPosId: 'A', defaultTerminalId: '' }, f.manager), /permissão/);
    await assert.rejects(() => savePaymentConfig(f.db, f.tenantId, f.storeId, { qrExternalPosId: 'A', defaultTerminalId: '' }, f.owner), /Access Token/);
    await assert.rejects(() => savePaymentConfig(f.db, f.tenantId, f.storeId, { accessToken: TOKEN, qrExternalPosId: 'caixa com espaço', defaultTerminalId: '' }, f.owner), /caixa inválido/);
    let summary = await savePaymentConfig(f.db, f.tenantId, f.storeId, { accessToken: TOKEN, webhookSecret: WEBHOOK_SECRET, qrExternalPosId: 'LOJA1CAIXA1', defaultTerminalId: '' }, f.owner);
    assert.deepEqual([summary.configured, summary.pixReady, summary.terminalReady, summary.hasWebhookSecret], [true, true, false, true]);
    assert.match(summary.webhookPath ?? '', /^\/api\/payments\/mercadopago\/webhook\/[a-f0-9]{48}$/);
    const raw = JSON.stringify(await f.db.prepare('SELECT * FROM payment_configs').bind().all());
    assert.ok(!raw.includes(TOKEN) && !raw.includes(WEBHOOK_SECRET), 'token/segredo não ficam em texto no banco');
    assert.ok(!JSON.stringify(summary).includes(TOKEN));
    // atualização sem token mantém o atual
    summary = await savePaymentConfig(f.db, f.tenantId, f.storeId, { qrExternalPosId: 'LOJA1CAIXA1', defaultTerminalId: 'NEWLAND_X' }, f.owner);
    assert.equal(summary.terminalReady, true);
    const view = await f.start('PIX_QR');
    assert.equal(view.status, 'PENDING', 'o token mantido continua funcionando');
});

test('Pix: cria venda PENDING_PAYMENT com estoque reservado; pago no provedor -> venda concluída', async () => {
    const f = await fixture();
    const view = await f.start('PIX_QR');
    assert.equal(view.status, 'PENDING');
    assert.equal(view.amount, 10000);
    assert.ok(view.qrData?.includes('MOCK'));
    assert.equal((await f.sale(view.saleId))?.status, 'PENDING_PAYMENT');
    assert.equal(await f.stock(), 8, 'estoque reservado enquanto espera');
    const orderId = (await f.chargeRow(view.id))?.orderId as string;
    f.mp.set(orderId, 'processed');
    const after = await refreshCharge(f.db, f.tenantId, view.id, f.operator, Date.now() + 5000, f.deps);
    assert.equal(after.status, 'PAID');
    assert.equal(after.qrData, null, 'QR some depois de pago');
    assert.equal((await f.sale(view.saleId))?.status, 'COMPLETED');
    assert.equal(await f.stock(), 8);
    const audit = await f.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payment.charge.paid'").bind().first<{ n: number }>();
    assert.equal(Number(audit?.n), 1);
});

test('Pix expirado ou cancelado no provedor: venda cancelada e estoque devolvido', async () => {
    for (const status of ['expired', 'canceled', 'failed']) {
        const f = await fixture();
        const view = await f.start('PIX_QR');
        f.mp.set((await f.chargeRow(view.id))?.orderId as string, status);
        const after = await refreshCharge(f.db, f.tenantId, view.id, f.operator, Date.now() + 5000, f.deps);
        assert.equal(after.status, { expired: 'EXPIRED', canceled: 'CANCELLED', failed: 'FAILED' }[status]);
        assert.equal((await f.sale(view.saleId))?.status, 'CANCELLED');
        assert.equal(await f.stock(), 10, `estoque volta (${status})`);
    }
});

test('valor pago diferente do cobrado NÃO conclui a venda: fica para conferência', async () => {
    const f = await fixture();
    const view = await f.start('PIX_QR');
    f.mp.set((await f.chargeRow(view.id))?.orderId as string, 'processed', { total_amount: '1.00' });
    const after = await refreshCharge(f.db, f.tenantId, view.id, f.operator, Date.now() + 5000, f.deps);
    assert.equal(after.status, 'ACTION_REQUIRED');
    assert.match(after.error, /não confere/);
    assert.equal((await f.sale(view.saleId))?.status, 'PENDING_PAYMENT');
});

test('desconto: a cobrança é pelo valor líquido calculado no servidor', async () => {
    const f = await fixture();
    const view = await startCharge(f.db, f.tenantId, { storeId: f.storeId, items: [{ productId: f.productId, qty: 2 }], customer: '', document: '', method: 'PIX_QR', discount: { percent: 10, reason: 'Cliente fiel' }, authorization: { email: 'ana@teste.com', password: PASSWORD } }, f.operator, Date.now(), f.deps);
    assert.equal(view.amount, 9000);
    const call = f.mp.calls.find((c) => c.method === 'POST' && c.path === '/v1/orders');
    assert.equal(call?.body?.total_amount, '90.00');
});

test('falha de rede na criação: cobrança fica CREATING e o worker recupera o MESMO pedido e o cancela (QR nunca exibido)', async () => {
    const f = await fixture();
    f.mp.failNext({ kind: 'network' });
    await assert.rejects(() => f.start('PIX_QR'), (e: { status?: number }) => e.status === 503);
    const charge = await f.db.prepare('SELECT id, sale_id AS saleId, status FROM payment_charges').bind().first<{ id: string; saleId: string; status: string }>();
    assert.equal(charge?.status, 'CREATING');
    assert.equal((await f.sale(charge!.saleId))?.status, 'PENDING_PAYMENT', 'venda segue reservada');
    const result = await reconcileOpenCharges(f.db, Date.now() + 60_000, f.deps);
    assert.deepEqual(result, { checked: 1, failed: 0 });
    assert.equal((await f.chargeRow(charge!.id))?.status, 'CANCELLED');
    assert.equal((await f.sale(charge!.saleId))?.status, 'CANCELLED');
    assert.equal(await f.stock(), 10, 'estoque reservado volta');
    assert.equal(f.mp.createCount, 1, 'a falha de rede aconteceu antes de chegar: um único pedido criado');
    assert.equal([...f.mp.orders.values()][0].status, 'canceled', 'pedido cancelado no provedor');
    // repetir a reconciliação não cria outro pedido
    await reconcileOpenCharges(f.db, Date.now() + 120_000, f.deps);
    assert.equal(f.mp.orders.size, 1);
});

test('recuperação usa a mesma chave: não cria pedido novo; se o pedido já tinha sido pago, conclui a venda', async () => {
    const f = await fixture();
    const view = await f.start('PIX_QR');
    const orderId = (await f.chargeRow(view.id))?.orderId as string;
    // MOCK de cenário: pedido criado e pago, mas a resposta da criação "se perdeu" do nosso lado.
    await f.db.prepare("UPDATE payment_charges SET status = 'CREATING', provider_order_id = NULL WHERE id = ?").bind(view.id).run();
    f.mp.set(orderId, 'processed');
    await reconcileOpenCharges(f.db, Date.now() + 60_000, f.deps);
    assert.equal(f.mp.orders.size, 1, 'nenhum pedido duplicado');
    assert.equal((await f.chargeRow(view.id))?.status, 'PAID');
    assert.equal((await f.sale(view.saleId))?.status, 'COMPLETED');
});

test('recusa definitiva do provedor (ex.: caixa inexistente): venda desfeita, estoque devolvido, erro claro', async () => {
    const f = await fixture();
    f.mp.failNext({ kind: 'http', status: 400, body: { errors: [{ code: 'invalid_pos', message: 'external_pos_id não encontrado' }] } });
    await assert.rejects(() => f.start('PIX_QR'), /external_pos_id não encontrado/);
    const charge = await f.db.prepare('SELECT status, sale_id AS saleId FROM payment_charges').bind().first<{ status: string; saleId: string }>();
    assert.equal(charge?.status, 'FAILED');
    assert.equal((await f.sale(charge!.saleId))?.status, 'CANCELLED');
    assert.equal(await f.stock(), 10);
});

test('cancelar cobrança: cancela no provedor e devolve o estoque; na maquininha já em uso, orienta cancelar no terminal', async () => {
    const f = await fixture();
    const view = await f.start('PIX_QR');
    const cancelled = await cancelCharge(f.db, f.tenantId, view.id, f.operator, Date.now(), f.deps);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(await f.stock(), 10);
    const call = f.mp.calls.find((c) => c.path.endsWith('/cancel'));
    assert.equal(call?.headers['X-Idempotency-Key'], `${view.id}-cancel`);

    const point = await f.start('CARD_TERMINAL');
    f.mp.set((await f.chargeRow(point.id))?.orderId as string, 'at_terminal');
    await assert.rejects(() => cancelCharge(f.db, f.tenantId, point.id, f.operator, Date.now(), f.deps), /cancele pelo próprio terminal/);
    assert.equal((await f.sale(point.saleId))?.status, 'PENDING_PAYMENT');
});

test('maquininha: "verificar no terminal" só é resolvido por quem tem PAYMENT_RESOLVE, com justificativa', async () => {
    const f = await fixture();
    const view = await f.start('CARD_TERMINAL');
    const orderId = (await f.chargeRow(view.id))?.orderId as string;
    assert.equal(f.mp.orders.get(orderId)?.terminal_id, 'NEWLAND_N950__N950NCB801293324');
    f.mp.set(orderId, 'action_required');
    assert.equal((await refreshCharge(f.db, f.tenantId, view.id, f.operator, Date.now() + 5000, f.deps)).status, 'ACTION_REQUIRED');
    await assert.rejects(() => resolveCharge(f.db, f.tenantId, view.id, 'PAID', 'Aprovado no visor da maquininha', f.operator, Date.now(), f.deps), /permissão/);
    await assert.rejects(() => resolveCharge(f.db, f.tenantId, view.id, 'PAID', 'ok', f.manager, Date.now(), f.deps), /mín. 10/);
    await assert.rejects(() => cancelCharge(f.db, f.tenantId, view.id, f.operator, Date.now(), f.deps), /Resolver cobrança/);
    const resolved = await resolveCharge(f.db, f.tenantId, view.id, 'PAID', 'Aprovado no visor da maquininha, NSU 123', f.manager, Date.now(), f.deps);
    assert.equal(resolved.status, 'PAID');
    assert.equal((await f.sale(view.saleId))?.status, 'COMPLETED');
    const row = await f.db.prepare('SELECT resolved_by AS by, resolution_note AS note FROM payment_charges WHERE id = ?').bind(view.id).first<{ by: string; note: string }>();
    assert.equal(row?.by, f.manager.userId);
    assert.match(row?.note ?? '', /NSU 123/);
});

test('resolução "não pago" desfaz a venda; se o provedor já decidiu, vale a decisão do provedor', async () => {
    const f = await fixture();
    const a = await f.start('CARD_TERMINAL');
    f.mp.set((await f.chargeRow(a.id))?.orderId as string, 'action_required');
    await refreshCharge(f.db, f.tenantId, a.id, f.operator, Date.now() + 5000, f.deps);
    assert.equal((await resolveCharge(f.db, f.tenantId, a.id, 'NOT_PAID', 'Recusado no terminal, cliente pagou em dinheiro', f.manager, Date.now(), f.deps)).status, 'FAILED');
    assert.equal((await f.sale(a.saleId))?.status, 'CANCELLED');

    const b = await f.start('CARD_TERMINAL');
    const orderB = (await f.chargeRow(b.id))?.orderId as string;
    f.mp.set(orderB, 'action_required');
    await refreshCharge(f.db, f.tenantId, b.id, f.operator, Date.now() + 5000, f.deps);
    f.mp.set(orderB, 'processed'); // provedor decidiu antes da resolução manual
    assert.equal((await resolveCharge(f.db, f.tenantId, b.id, 'NOT_PAID', 'Tentativa de marcar como não pago', f.manager, Date.now(), f.deps)).status, 'PAID');
});

test('venda paga por integração: cancelar estorna TOTAL no provedor antes; devolução parcial e cancelamento direto são bloqueados', async () => {
    const f = await fixture();
    const view = await f.start('PIX_QR');
    const orderId = (await f.chargeRow(view.id))?.orderId as string;
    // enquanto pendente, a venda não é cancelada pelo fluxo comercial
    await assert.rejects(() => cancelSale(f.db, f.tenantId, view.saleId, f.owner), /cobrança integrada em andamento/);
    f.mp.set(orderId, 'processed');
    await refreshCharge(f.db, f.tenantId, view.id, f.operator, Date.now() + 5000, f.deps);
    await assert.rejects(() => cancelSale(f.db, f.tenantId, view.saleId, f.owner), /estornar o pagamento no provedor/);
    await assert.rejects(() => returnSale(f.db, f.tenantId, { saleId: view.saleId, items: [{ productId: f.productId, qty: 1, restock: true }], reason: 'Teste', refundMethod: 'Pix' }, f.manager), /só faz estorno total/);
    await dispatchCommand(f.db, f.tenantId, f.ownerAtStore, plan, { type: 'sale.cancel', id: view.saleId, reason: 'Cliente desistiu' } as never, Date.now(), { payments: f.deps });
    assert.equal(f.mp.orders.get(orderId)?.status, 'refunded');
    assert.equal((await f.chargeRow(view.id))?.status, 'REFUNDED');
    assert.equal((await f.sale(view.saleId))?.status, 'CANCELLED');
    assert.equal(await f.stock(), 10);
});

test('estorno recusado pelo provedor: a venda NÃO é cancelada', async () => {
    const f = await fixture();
    const view = await f.start('PIX_QR');
    f.mp.set((await f.chargeRow(view.id))?.orderId as string, 'processed');
    await refreshCharge(f.db, f.tenantId, view.id, f.operator, Date.now() + 5000, f.deps);
    f.mp.failNext({ kind: 'http', status: 400, body: { errors: [{ code: 'in_store_payment_refund_order', message: 'prazo de estorno excedido' }] } });
    await assert.rejects(() => dispatchCommand(f.db, f.tenantId, f.ownerAtStore, plan, { type: 'sale.cancel', id: view.saleId, reason: 'Teste' } as never, Date.now(), { payments: f.deps }), /prazo de estorno excedido/);
    assert.equal((await f.sale(view.saleId))?.status, 'COMPLETED');
    assert.equal((await f.chargeRow(view.id))?.status, 'PAID');
});

test('webhook: assinatura inválida/ausente é recusada; válida só dispara consulta (o corpo não decide)', async () => {
    const f = await fixture();
    const view = await f.start('PIX_QR');
    const orderId = (await f.chargeRow(view.id))?.orderId as string;
    const summary = await getPaymentConfigSummary(f.db, f.tenantId, f.storeId);
    const key = (summary.webhookPath ?? '').split('/').pop() as string;
    const sign = (id: string, requestId: string, ts = '1700000000000') => `ts=${ts},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex')}`;

    assert.equal(await handleMercadoPagoWebhook(f.db, 'a'.repeat(48), { xSignature: sign(orderId, 'r1'), xRequestId: 'r1', dataId: orderId }, Date.now(), f.deps), 404);
    assert.equal(await handleMercadoPagoWebhook(f.db, 'nao-hex', { xSignature: null, xRequestId: null, dataId: null }, Date.now(), f.deps), 404);
    assert.equal(await handleMercadoPagoWebhook(f.db, key, { xSignature: null, xRequestId: 'r1', dataId: orderId }, Date.now(), f.deps), 401);
    assert.equal(await handleMercadoPagoWebhook(f.db, key, { xSignature: sign(orderId, 'r1').replace(/v1=./, 'v1=0'), xRequestId: 'r1', dataId: orderId }, Date.now(), f.deps), 401);

    // assinatura válida mas o provedor ainda diz "created": nada muda
    assert.equal(await handleMercadoPagoWebhook(f.db, key, { xSignature: sign(orderId, 'r2'), xRequestId: 'r2', dataId: orderId }, Date.now(), f.deps), 200);
    assert.equal((await f.chargeRow(view.id))?.status, 'PENDING');
    f.mp.set(orderId, 'processed');
    assert.equal(await handleMercadoPagoWebhook(f.db, key, { xSignature: sign(orderId, 'r3'), xRequestId: 'r3', dataId: orderId }, Date.now(), f.deps), 200);
    assert.equal((await f.sale(view.saleId))?.status, 'COMPLETED');
    // pedido desconhecido: 200 sem efeito
    assert.equal(await handleMercadoPagoWebhook(f.db, key, { xSignature: sign('ORD9', 'r4'), xRequestId: 'r4', dataId: 'ORD9' }, Date.now(), f.deps), 200);
});

test('webhook sem segredo configurado na loja é recusado (nunca aceita notificação sem validar)', async () => {
    const f = await fixture({ secret: null });
    const key = ((await getPaymentConfigSummary(f.db, f.tenantId, f.storeId)).webhookPath ?? '').split('/').pop() as string;
    assert.equal(await handleMercadoPagoWebhook(f.db, key, { xSignature: 'ts=1,v1=00', xRequestId: 'r', dataId: 'ORD1' }, Date.now(), f.deps), 401);
});

test('webhook e tela confirmando ao mesmo tempo: a venda é concluída uma única vez', async () => {
    const f = await fixture();
    const view = await f.start('PIX_QR');
    f.mp.set((await f.chargeRow(view.id))?.orderId as string, 'processed');
    await Promise.all([
        refreshCharge(f.db, f.tenantId, view.id, f.operator, Date.now() + 5000, f.deps),
        reconcileOpenCharges(f.db, Date.now() + 60_000, f.deps),
        refreshCharge(f.db, f.tenantId, view.id, f.manager, Date.now() + 9000, f.deps),
    ]);
    const audit = await f.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payment.charge.paid'").bind().first<{ n: number }>();
    assert.equal(Number(audit?.n), 1);
    assert.equal((await f.sale(view.saleId))?.status, 'COMPLETED');
});

test('consulta ao provedor limitada a uma a cada 2 s por cobrança', async () => {
    const f = await fixture();
    const view = await f.start('PIX_QR');
    const t0 = Date.now() + 10_000;
    await refreshCharge(f.db, f.tenantId, view.id, f.operator, t0, f.deps);
    await refreshCharge(f.db, f.tenantId, view.id, f.operator, t0 + 500, f.deps);
    await refreshCharge(f.db, f.tenantId, view.id, f.operator, t0 + 2500, f.deps);
    assert.equal(f.mp.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/v1/orders/')).length, 2);
});

test('sem configuração, sem caixa ou sem maquininha: bloqueia com orientação (nada é presumido)', async () => {
    const none = await fixture({ configure: false });
    await assert.rejects(() => none.start('PIX_QR'), /não configurado/);
    const noPos = await fixture({ posId: '' });
    await assert.rejects(() => noPos.start('PIX_QR'), /external_pos_id/);
    const noTerminal = await fixture({ terminal: '' });
    await assert.rejects(() => noTerminal.start('CARD_TERMINAL'), /Nenhuma maquininha/);
    assert.equal(await noTerminal.stock(), 10, 'nenhuma venda reservada');
});

test('venda aguardando pagamento: não gera documento fiscal e não entra nos relatórios', async () => {
    const f = await fixture();
    const view = await f.start('PIX_QR');
    await assert.rejects(() => generateNFeForSale(f.db, f.tenantId, view.saleId, f.owner), /aguardando confirmação do pagamento/);
    const report = await getSalesReport(f.db, f.tenantId, f.owner);
    assert.equal(report.totals.count, 0);
    f.mp.set((await f.chargeRow(view.id))?.orderId as string, 'processed');
    await refreshCharge(f.db, f.tenantId, view.id, f.operator, Date.now() + 5000, f.deps);
    assert.equal((await getSalesReport(f.db, f.tenantId, f.owner)).totals.total, 10000);
});

test('comandos: payment.charge.start é idempotente pela chave e auditado sem senha; config não audita segredos', async () => {
    const f = await fixture();
    const command = { type: 'payment.charge.start', storeId: f.storeId, items: [{ productId: f.productId, qty: 1 }], customer: '', document: '', method: 'PIX_QR' } as never;
    const id = await dispatchCommand(f.db, f.tenantId, f.operator, plan, command, Date.now(), { payments: f.deps });
    assert.ok(id);
    await dispatchCommand(f.db, f.tenantId, f.owner, plan, { type: 'payment.config.save', storeId: f.storeId, accessToken: TOKEN, webhookSecret: WEBHOOK_SECRET, qrExternalPosId: 'LOJA1CAIXA1', defaultTerminalId: '' } as never, Date.now(), { payments: f.deps });
    const audit = JSON.stringify(await f.db.prepare('SELECT description, after_data FROM audit_logs').bind().all());
    assert.ok(!audit.includes(TOKEN) && !audit.includes(WEBHOOK_SECRET), 'segredo vazou para a auditoria');
    assert.match(audit, /Cobrança Pix/);
    await assert.rejects(() => dispatchCommand(f.db, f.tenantId, f.operator, plan, { type: 'payment.config.save', storeId: f.storeId, qrExternalPosId: 'X', defaultTerminalId: '' } as never, Date.now(), { payments: f.deps }), /permissão/);
});

test('imagem do QR: com a biblioteca qrcode instalada, o Pix pendente vem com SVG pronto para a tela', async () => {
    const { qrSvg } = await import('../lib/payments/qrImage.ts');
    const svg = await qrSvg('00020101021226830014BR.GOV.BCB.PIX2561exemplo-sintetico-de-teste');
    assert.ok(svg && svg.includes('<svg'), 'deve gerar SVG');
    assert.equal(await qrSvg(''), null);
    const f = await fixture();
    const view = await f.start('PIX_QR');
    assert.ok(view.qrSvg?.includes('<svg'), 'a cobrança pendente traz a imagem');
});

test('credencial ilegível (FISCAL_SECRET_KEY trocada): erro explica o que fazer, sem mensagem técnica crua', async () => {
    const f = await fixture();
    // MOCK de cenário: grava um "token criptografado" corrompido, como ficaria com outra chave.
    await f.db.prepare('UPDATE payment_configs SET access_token_enc = ?').bind(JSON.stringify({ ciphertext: 'AAAA', iv: 'AAAAAAAAAAAAAAAA', salt: 'AAAAAAAAAAAAAAAAAAAAAA==', authTag: 'AAAAAAAAAAAAAAAAAAAAAA==' })).run();
    await assert.rejects(() => f.start('PIX_QR'), /Salve o Access Token e o segredo do webhook novamente/);
    assert.equal(await f.stock(), 10, 'venda não ficou reservada');
});
