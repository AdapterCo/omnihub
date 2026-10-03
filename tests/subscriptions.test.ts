import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { registerAccount } from '../lib/auth/service.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { requireActive } from '../lib/domain.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import { createStore } from '../lib/catalog/service.ts';
import { MercadoPagoClient, type FetchLike } from '../lib/payments/mercadopago.ts';
import {
    addOneMonth, cancelAccountSubscription, getPlatformOverview, listPlatformPlans, reconcileOpenSubscriptions,
    reconcileSubscription, resolveEntitlement, savePlatformPlan, setAdminMaxStores, startSubscription, type SubscriptionDeps,
} from '../lib/subscriptions/service.ts';

const ADMIN = 'admin@plataforma.test';
const ENV = { PLATFORM_ADMIN_EMAILS: ADMIN, PLATFORM_MP_ACCESS_TOKEN: 'TEST-MOCK-TOKEN', APP_URL: 'https://omnihub.test' };
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 3, 15, 0, 0);

/**
 * MOCK do Mercado Pago (assinaturas): reproduz o contrato da referência oficial (POST/GET/PUT
 * /preapproval, /preapproval/search, /authorized_payments/{id} e /search). Só existe nos testes,
 * porque a API real exige a conta Mercado Pago da empresa.
 */
function mockMercadoPago() {
    type Pre = { id: string; status: string; external_reference: string; [k: string]: unknown };
    type Inv = { id: string; preapproval_id: string; transaction_amount: string; debit_date: string; status: string; payment: { id: number; status: string } };
    const pres = new Map<string, Pre>();
    const invoices: Inv[] = [];
    const calls: { method: string; path: string; body: unknown }[] = [];
    let seq = 0;
    const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    const fetch: FetchLike = async (url, init) => {
        const path = url.replace('https://api.mercadopago.com', '');
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method: init.method, path, body });
        if (init.method === 'POST' && path === '/preapproval') {
            const id = `pre-${++seq}`;
            const pre = { ...body, id, status: 'pending', init_point: `https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=${id}` };
            pres.set(id, pre);
            return reply(201, pre);
        }
        const search = /^\/preapproval\/search\?external_reference=(.+)$/.exec(path);
        if (search) return reply(200, { results: [...pres.values()].filter((p) => p.external_reference === decodeURIComponent(search[1])) });
        const one = /^\/preapproval\/([^/?]+)$/.exec(path);
        if (one) {
            const pre = pres.get(decodeURIComponent(one[1]));
            if (!pre) return reply(404, { message: 'not found' });
            if (init.method === 'PUT') Object.assign(pre, body);
            return reply(200, pre);
        }
        const invSearch = /^\/authorized_payments\/search\?preapproval_id=(.+)$/.exec(path);
        if (invSearch) return reply(200, { results: invoices.filter((i) => i.preapproval_id === decodeURIComponent(invSearch[1])) });
        const inv = /^\/authorized_payments\/(.+)$/.exec(path);
        if (inv) {
            const found = invoices.find((i) => i.id === decodeURIComponent(inv[1]));
            return found ? reply(200, found) : reply(404, { message: 'not found' });
        }
        return reply(404, { message: `rota não simulada: ${path}` });
    };
    return {
        fetch, calls, pres,
        authorize: (id: string) => { pres.get(id)!.status = 'authorized'; },
        pay: (preapprovalId: string, debitDate: number, amount: string, paymentStatus = 'approved') => {
            const id = String(9000 + invoices.length);
            invoices.push({ id, preapproval_id: preapprovalId, transaction_amount: amount, debit_date: new Date(debitDate).toISOString(), status: 'processed', payment: { id: 100 + invoices.length, status: paymentStatus } });
            return id;
        },
    };
}

async function fixture(email = 'dona@cliente.test') {
    const db = createFakeD1();
    const reg = await registerAccount(db, { accountName: 'Loja MOCK', displayName: 'Dona', email, password: 'Test-only-password-123' }, T0);
    const owner = { userId: reg.userId, displayName: 'Dona', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };
    const mp = mockMercadoPago();
    const deps: SubscriptionDeps = { client: new MercadoPagoClient('TEST-MOCK-TOKEN', mp.fetch), appUrl: 'https://omnihub.test' };
    const entitlement = async () => {
        const row = await db.prepare('SELECT subscription_status AS status, access_until AS accessUntil, max_stores AS maxStores FROM accounts WHERE id = ?').bind(reg.accountId).first<{ status: string; accessUntil: number; maxStores: number }>();
        return resolveEntitlement(db, reg.accountId, { status: row!.status, accessUntil: Number(row!.accessUntil), maxStores: Number(row!.maxStores) }, ENV);
    };
    const plan = (name: string, priceCents: number, maxStores: number) => savePlatformPlan(db, ADMIN, { name, priceCents, maxStores, active: true }, ENV, T0);
    return { db, reg, owner, mp, deps, entitlement, plan, tenantId: reg.accountId };
}

test('conta nova nasce sem acesso e sem lojas; nada funciona até assinar', async () => {
    const f = await fixture();
    const ent = await f.entitlement();
    assert.deepEqual([ent.status, ent.accessUntil, ent.maxStores, ent.platform], ['none', 0, 0, false]);
    assert.throws(() => requireActive(ent, T0), /Escolha um plano/);
    await assert.rejects(() => dispatchCommand(f.db, f.tenantId, f.owner, ent, { type: 'store.create', data: { name: 'Loja 1' } } as never, T0), /Escolha um plano/);
});

test('planos: só o administrador da plataforma cadastra; nenhum plano pré-cadastrado; validações', async () => {
    const f = await fixture();
    assert.deepEqual(await listPlatformPlans(f.db), []);
    await assert.rejects(() => savePlatformPlan(f.db, 'dona@cliente.test', { name: 'Básico', priceCents: 9900, maxStores: 1, active: true }, ENV, T0), /administradores da plataforma/);
    await assert.rejects(() => f.plan('Básico', 0, 1), /preço/);
    await assert.rejects(() => f.plan('Básico', 9900, 0), /Limite de lojas/);
    const id = await f.plan('Básico', 9900, 1);
    await assert.rejects(() => f.plan('básico', 5000, 1), /Já existe/);
    await savePlatformPlan(f.db, ADMIN, { id, name: 'Básico', priceCents: 9900, maxStores: 1, active: false }, ENV, T0);
    assert.deepEqual(await listPlatformPlans(f.db, { onlyActive: true }), []);
    await assert.rejects(() => getPlatformOverview(f.db, 'dona@cliente.test', ENV), /administradores/);
    const overview = await getPlatformOverview(f.db, ADMIN, ENV);
    assert.deepEqual(overview.billingProblems, []);
    assert.equal(overview.accounts.length, 1);
});

test('assinar: cria assinatura mensal pendente no Mercado Pago e só libera acesso com fatura paga no valor certo', async () => {
    const f = await fixture();
    const planId = await f.plan('Pro', 19990, 3);
    await assert.rejects(() => startSubscription(f.db, f.tenantId, f.owner, { planId, payerEmail: 'pagador@mock.test' }, { client: null, appUrl: null }, T0), /não foi configurada/);
    await assert.rejects(() => startSubscription(f.db, f.tenantId, { ...f.owner, userId: 'outro' }, { planId, payerEmail: 'pagador@mock.test' }, f.deps, T0), /titular/);
    await assert.rejects(() => startSubscription(f.db, f.tenantId, f.owner, { planId, payerEmail: 'sem-arroba' }, f.deps, T0), /e-mail/);
    const { subscriptionId, initPoint } = await startSubscription(f.db, f.tenantId, f.owner, { planId, payerEmail: 'Pagador@Mock.test' }, f.deps, T0);
    assert.match(initPoint, /subscriptions\/checkout\?preapproval_id=pre-1/);
    const sent = f.mp.calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    assert.equal(sent.external_reference, subscriptionId);
    assert.equal(sent.payer_email, 'pagador@mock.test');
    assert.equal(sent.status, 'pending');
    assert.equal(sent.back_url, 'https://omnihub.test/?assinatura=retorno');
    assert.deepEqual(sent.auto_recurring, { frequency: 1, frequency_type: 'months', transaction_amount: 199.9, currency_id: 'BRL' });
    assert.equal((await f.entitlement()).status, 'none', 'sem pagamento, sem acesso');

    // Fatura com valor divergente ou pagamento recusado não libera nada.
    f.mp.authorize('pre-1');
    f.mp.pay('pre-1', T0, '1.00');
    f.mp.pay('pre-1', T0, '199.90', 'rejected');
    await reconcileSubscription(f.db, subscriptionId, f.deps.client!, T0 + 1000);
    assert.equal((await f.entitlement()).status, 'none');

    f.mp.pay('pre-1', T0 + 60_000, '199.90');
    await reconcileSubscription(f.db, subscriptionId, f.deps.client!, T0 + 120_000);
    const ent = await f.entitlement();
    assert.equal(ent.status, 'active');
    assert.equal(ent.maxStores, 3);
    assert.equal(ent.accessUntil, addOneMonth(T0 + 60_000));
    const storeId = await dispatchCommand(f.db, f.tenantId, f.owner, ent, { type: 'store.create', data: { name: 'Loja 1' } } as never, T0 + 130_000);
    assert.ok(storeId);
});

test('sem webhook: a fatura paga é encontrada pela consulta periódica do worker', async () => {
    const f = await fixture();
    const planId = await f.plan('Pro', 5000, 2);
    await startSubscription(f.db, f.tenantId, f.owner, { planId, payerEmail: 'pagador@mock.test' }, f.deps, T0);
    f.mp.authorize('pre-1');
    f.mp.pay('pre-1', T0, '50.00');
    assert.equal((await f.entitlement()).status, 'none');
    await reconcileOpenSubscriptions(f.db, f.deps.client!, T0 + 5 * 60 * 1000);
    assert.equal((await f.entitlement()).status, 'active');
});

test('troca de plano: o novo pago cancela o anterior no Mercado Pago; plano menor que as lojas é recusado', async () => {
    const f = await fixture();
    const small = await f.plan('Básico', 5000, 1);
    const big = await f.plan('Pro', 9000, 3);
    const first = await startSubscription(f.db, f.tenantId, f.owner, { planId: small, payerEmail: 'p@mock.test' }, f.deps, T0);
    f.mp.authorize('pre-1');
    f.mp.pay('pre-1', T0, '50.00');
    await reconcileSubscription(f.db, first.subscriptionId, f.deps.client!, T0 + 1000);
    const ent = await f.entitlement();
    await createStore(f.db, f.tenantId, { name: 'Loja 1' }, f.owner as never);
    await assert.rejects(() => dispatchCommand(f.db, f.tenantId, f.owner, ent, { type: 'store.create', data: { name: 'Loja 2' } } as never, T0 + 2000), /Limite de lojas/);
    const second = await startSubscription(f.db, f.tenantId, f.owner, { planId: big, payerEmail: 'p@mock.test' }, f.deps, T0 + 3000);
    f.mp.authorize('pre-2');
    f.mp.pay('pre-2', T0 + 4000, '90.00');
    await reconcileSubscription(f.db, second.subscriptionId, f.deps.client!, T0 + 5000);
    assert.equal(f.mp.pres.get('pre-1')!.status, 'cancelled', 'assinatura anterior cancelada no Mercado Pago');
    assert.equal((await f.entitlement()).maxStores, 3);
    await createStore(f.db, f.tenantId, { name: 'Loja 2' }, f.owner as never);
    await assert.rejects(() => startSubscription(f.db, f.tenantId, f.owner, { planId: small, payerEmail: 'p@mock.test' }, f.deps, T0 + 6000), /2 lojas e o plano Básico permite 1/);
});

test('cancelar: para as cobranças, acesso continua até o fim do período pago e depois bloqueia (zero tolerância)', async () => {
    const f = await fixture();
    const planId = await f.plan('Pro', 5000, 2);
    const { subscriptionId } = await startSubscription(f.db, f.tenantId, f.owner, { planId, payerEmail: 'p@mock.test' }, f.deps, T0);
    f.mp.authorize('pre-1');
    f.mp.pay('pre-1', T0, '50.00');
    await reconcileSubscription(f.db, subscriptionId, f.deps.client!, T0 + 1000);
    await assert.rejects(() => cancelAccountSubscription(f.db, f.tenantId, { ...f.owner, userId: 'outro' }, f.deps, T0 + 2000), /titular/);
    await cancelAccountSubscription(f.db, f.tenantId, f.owner, f.deps, T0 + 2000);
    assert.equal(f.mp.pres.get('pre-1')!.status, 'cancelled');
    let ent = await f.entitlement();
    assert.equal(ent.status, 'cancelled');
    requireActive(ent, T0 + 10 * DAY); // ainda no período pago
    const paidUntil = addOneMonth(T0);
    await reconcileOpenSubscriptions(f.db, f.deps.client!, paidUntil + 1);
    ent = await f.entitlement();
    assert.equal(ent.status, 'expired');
    assert.throws(() => requireActive(ent, paidUntil + 1), /período de acesso terminou/);
});

test('renovação não paga: acesso termina exatamente no fim do mês pago; nova cobrança aprovada reabre', async () => {
    const f = await fixture();
    const planId = await f.plan('Pro', 5000, 2);
    const { subscriptionId } = await startSubscription(f.db, f.tenantId, f.owner, { planId, payerEmail: 'p@mock.test' }, f.deps, T0);
    f.mp.authorize('pre-1');
    f.mp.pay('pre-1', T0, '50.00');
    await reconcileSubscription(f.db, subscriptionId, f.deps.client!, T0 + 1000);
    const paidUntil = addOneMonth(T0);
    f.mp.pay('pre-1', paidUntil, '50.00', 'rejected'); // renovação recusada
    await reconcileOpenSubscriptions(f.db, f.deps.client!, paidUntil + 1);
    assert.equal((await f.entitlement()).status, 'expired');
    f.mp.pay('pre-1', paidUntil + DAY, '50.00'); // nova tentativa aprovada
    await reconcileOpenSubscriptions(f.db, f.deps.client!, paidUntil + DAY + 1);
    const ent = await f.entitlement();
    assert.equal(ent.status, 'active');
    assert.equal(ent.accessUntil, addOneMonth(paidUntil + DAY));
});

test('criação com resposta perdida: recupera pela referência externa sem criar outra assinatura', async () => {
    const f = await fixture();
    const planId = await f.plan('Pro', 5000, 2);
    // MOCK de falha: o Mercado Pago cria a assinatura, mas a resposta não chega ao OmniHub.
    let created = '';
    const flaky: FetchLike = async (url, init) => {
        if (init.method === 'POST' && !created) {
            const r = await f.mp.fetch(url, init);
            created = JSON.parse(await r.text()).id;
            throw new Error('timeout (simulado)');
        }
        return f.mp.fetch(url, init);
    };
    const deps = { client: new MercadoPagoClient('TEST-MOCK-TOKEN', flaky), appUrl: 'https://omnihub.test' };
    await assert.rejects(() => startSubscription(f.db, f.tenantId, f.owner, { planId, payerEmail: 'p@mock.test' }, deps, T0), /não respondeu/);
    await reconcileOpenSubscriptions(f.db, deps.client, T0 + 5 * 60 * 1000);
    const row = await f.db.prepare('SELECT status, preapproval_id AS pre FROM account_subscriptions').bind().first<{ status: string; pre: string }>();
    assert.deepEqual([row?.status, row?.pre], ['PENDING', created]);
    assert.equal(f.mp.pres.size, 1, 'nenhuma assinatura duplicada');
});

test('administrador da plataforma: conta liberada sem pagar, com o limite de lojas definido no painel', async () => {
    const f = await fixture(ADMIN);
    let ent = await f.entitlement();
    assert.equal(ent.platform, true);
    assert.equal(ent.maxStores, 0, 'sem limite definido no painel: 0 (nada presumido)');
    requireActive(ent, T0);
    await assert.rejects(() => setAdminMaxStores(f.db, 'dona@cliente.test', 5, ENV, T0), /administradores/);
    await setAdminMaxStores(f.db, ADMIN, 5, ENV, T0);
    ent = await f.entitlement();
    assert.equal(ent.maxStores, 5);
});

test('um mês depois: fim de mês vira o último dia do mês seguinte', () => {
    assert.equal(new Date(addOneMonth(Date.UTC(2026, 0, 31, 12))).toISOString(), '2026-02-28T12:00:00.000Z');
    assert.equal(new Date(addOneMonth(Date.UTC(2026, 11, 15))).toISOString(), '2027-01-15T00:00:00.000Z');
});
