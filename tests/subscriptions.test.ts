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
    addOneMonth, cancelRenewal, checkInvoice, choosePlan, getPlatformOverview, getSignupOptions, getSubscriptionPage, listPlatformPlans, payInvoice,
    registerWithPlan, resolveEntitlement, runSubscriptionCycle, savePlatformPlan, setAdminMaxStores, type SubscriptionDeps,
} from '../lib/subscriptions/service.ts';

const ADMIN = 'admin@plataforma.test';
const ENV = { PLATFORM_ADMIN_EMAILS: ADMIN, PLATFORM_MP_ACCESS_TOKEN: 'TEST-MOCK-TOKEN' };
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 3, 15, 0, 0);

/**
 * MOCK do Mercado Pago (pagamentos): reproduz o contrato da referência oficial de POST /v1/payments
 * (Pix com point_of_interaction.transaction_data; cartão com token) e GET /v1/payments/{id}, inclusive
 * a idempotência por X-Idempotency-Key. Só existe nos testes: a API real exige a conta da empresa.
 */
function mockMercadoPago() {
    type Pay = { id: number; status: string; status_detail: string; external_reference: string; transaction_amount: number; [k: string]: unknown };
    const payments = new Map<string, Pay>();
    const byKey = new Map<string, string>();
    const calls: { method: string; path: string; body: Record<string, unknown> | undefined; key: string | undefined }[] = [];
    let seq = 0;
    let nextCardStatus = 'approved';
    const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    const fetch: FetchLike = async (url, init) => {
        const path = url.replace('https://api.mercadopago.com', '');
        const body = init.body ? JSON.parse(init.body) : undefined;
        const key = init.headers['X-Idempotency-Key'];
        calls.push({ method: init.method, path, body, key });
        if (init.method === 'POST' && path === '/v1/payments') {
            if (key && byKey.has(key)) return reply(200, payments.get(byKey.get(key)!));
            const id = 5000 + ++seq;
            const pix = body.payment_method_id === 'pix';
            const p: Pay = {
                id, status: pix ? 'pending' : nextCardStatus, status_detail: pix ? 'pending_waiting_transfer' : nextCardStatus === 'approved' ? 'accredited' : 'cc_rejected_insufficient_amount',
                external_reference: body.external_reference, transaction_amount: body.transaction_amount,
                ...(pix ? { point_of_interaction: { transaction_data: { qr_code: `00020126MOCKPIX${id}`, qr_code_base64: 'iVBORw0KGgoMOCK', ticket_url: `https://www.mercadopago.com.br/payments/${id}/ticket` } } } : {}),
            };
            payments.set(String(id), p);
            if (key) byKey.set(key, String(id));
            return reply(201, p);
        }
        const one = /^\/v1\/payments\/(\d+)$/.exec(path);
        if (one && init.method === 'GET') {
            const p = payments.get(one[1]);
            return p ? reply(200, p) : reply(404, { message: 'not found' });
        }
        return reply(404, { message: `rota não simulada: ${path}` });
    };
    return {
        fetch, calls, payments,
        set: (id: string, patch: Partial<Pay>) => Object.assign(payments.get(id)!, patch),
        cardStatus: (s: string) => { nextCardStatus = s; },
        posts: () => calls.filter((c) => c.method === 'POST'),
    };
}

async function fixture(email = 'dona@cliente.test') {
    const db = createFakeD1();
    const reg = await registerAccount(db, { accountName: 'Loja MOCK', displayName: 'Dona', email, password: 'Test-only-password-123' }, T0);
    const owner = { userId: reg.userId, displayName: 'Dona', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };
    const mp = mockMercadoPago();
    const deps: SubscriptionDeps = { client: new MercadoPagoClient('TEST-MOCK-TOKEN', mp.fetch) };
    const entitlement = async () => {
        const row = await db.prepare('SELECT subscription_status AS status, access_until AS accessUntil, max_stores AS maxStores FROM accounts WHERE id = ?').bind(reg.accountId).first<{ status: string; accessUntil: number; maxStores: number }>();
        return resolveEntitlement(db, reg.accountId, { status: row!.status, accessUntil: Number(row!.accessUntil), maxStores: Number(row!.maxStores) }, ENV);
    };
    const plan = (name: string, priceCents: number, maxStores: number) => savePlatformPlan(db, ADMIN, { name, priceCents, maxStores, active: true }, ENV, T0);
    const payPix = async (invoiceId: string, now = T0) => payInvoice(db, reg.accountId, invoiceId, { method: 'pix', payerEmail: 'Pagador@Mock.test' }, deps, now);
    return { db, reg, owner, mp, deps, entitlement, plan, payPix, tenantId: reg.accountId };
}

test('conta nova nasce sem acesso e sem lojas; nada funciona até pagar', async () => {
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

test('Pix: escolher o plano gera a fatura; o QR Code vem do Mercado Pago; só libera com pagamento aprovado', async () => {
    const f = await fixture();
    const planId = await f.plan('Pro', 19990, 3);
    await assert.rejects(() => choosePlan(f.db, f.tenantId, { ...f.owner, userId: 'outro' }, planId, T0), /titular/);
    await assert.rejects(() => choosePlan(f.db, f.tenantId, f.owner, 'inexistente', T0), /não encontrado/);
    const invoice = await choosePlan(f.db, f.tenantId, f.owner, planId, T0);
    assert.deepEqual([invoice.status, invoice.amountCents, invoice.planName], ['pending', 19990, 'Pro']);
    await assert.rejects(() => payInvoice(f.db, f.tenantId, invoice.id, { method: 'pix', payerEmail: 'p@mock.test' }, { client: null }, T0), /não foi configurado/);
    await assert.rejects(() => payInvoice(f.db, 'outra-conta', invoice.id, { method: 'pix', payerEmail: 'p@mock.test' }, f.deps, T0), /não encontrada/);
    await assert.rejects(() => payInvoice(f.db, f.tenantId, invoice.id, { method: 'pix', payerEmail: 'sem-arroba' }, f.deps, T0), /e-mail/);
    await assert.rejects(() => payInvoice(f.db, f.tenantId, invoice.id, { method: 'boleto', payerEmail: 'p@mock.test' }, f.deps, T0), /Pix ou cartão/);

    const r = await f.payPix(invoice.id);
    assert.equal(r.paymentStatus, 'pending');
    assert.match(r.qrCode!, /^00020126MOCKPIX/);
    assert.equal(r.qrCodeBase64, 'iVBORw0KGgoMOCK');
    const sent = f.mp.posts()[0];
    assert.deepEqual(sent.body, { transaction_amount: 199.9, description: 'OmniHub - plano Pro', external_reference: invoice.id, payer: { email: 'pagador@mock.test' }, payment_method_id: 'pix' });
    assert.equal(sent.key, `${invoice.id}-pix-pix`);
    // Gerar de novo não cria outra cobrança (mesma chave de idempotência).
    await f.payPix(invoice.id);
    assert.equal(f.mp.payments.size, 1);

    assert.equal((await checkInvoice(f.db, f.tenantId, invoice.id, f.deps, T0 + 5000)).status, 'pending');
    assert.equal((await f.entitlement()).status, 'none', 'sem pagamento, sem acesso');

    f.mp.set('5001', { status: 'approved', status_detail: 'accredited' });
    const paid = await checkInvoice(f.db, f.tenantId, invoice.id, f.deps, T0 + 60_000);
    assert.equal(paid.status, 'paid');
    const ent = await f.entitlement();
    assert.deepEqual([ent.status, ent.maxStores, ent.accessUntil], ['active', 3, addOneMonth(T0 + 60_000)]);
    const storeId = await dispatchCommand(f.db, f.tenantId, f.owner, ent, { type: 'store.create', data: { name: 'Loja 1' } } as never, T0 + 70_000);
    assert.ok(storeId);
    // Consultar de novo não libera outro mês.
    await checkInvoice(f.db, f.tenantId, invoice.id, f.deps, T0 + 80_000);
    assert.equal((await f.entitlement()).accessUntil, addOneMonth(T0 + 60_000));
});

test('recusa do Mercado Pago aparece com o motivo e a fatura continua pendente', async () => {
    const f = await fixture();
    const planId = await f.plan('Pro', 5000, 2);
    const invoice = await choosePlan(f.db, f.tenantId, f.owner, planId, T0);
    // MOCK de recusa (token inválido), como a API real responde.
    const refuse: FetchLike = async () => ({ status: 401, text: async () => JSON.stringify({ message: 'authorization value not present' }) });
    await assert.rejects(
        () => payInvoice(f.db, f.tenantId, invoice.id, { method: 'pix', payerEmail: 'p@mock.test' }, { client: new MercadoPagoClient('TEST-MOCK-TOKEN', refuse) }, T0),
        (e: Error & { status?: number }) => /HTTP 401\): authorization value not present/.test(e.message) && e.status === 422,
    );
    assert.equal((await getSubscriptionPage(f.db, f.tenantId, ENV)).invoices[0].status, 'pending');
});

test('pagamento com referência ou valor diferente da fatura não libera acesso', async () => {
    const f = await fixture();
    const planId = await f.plan('Pro', 5000, 2);
    const invoice = await choosePlan(f.db, f.tenantId, f.owner, planId, T0);
    await f.payPix(invoice.id);
    f.mp.set('5001', { status: 'approved', transaction_amount: 1 });
    assert.equal((await checkInvoice(f.db, f.tenantId, invoice.id, f.deps, T0 + 1000)).status, 'pending');
    f.mp.set('5001', { transaction_amount: 50, external_reference: 'outra-fatura' });
    assert.equal((await checkInvoice(f.db, f.tenantId, invoice.id, f.deps, T0 + 2000)).status, 'pending');
    assert.equal((await f.entitlement()).status, 'none');
});

test('cartão: token do formulário seguro; aprovado libera na hora; recusado marca a fatura e permite tentar de novo', async () => {
    const f = await fixture();
    const planId = await f.plan('Pro', 5000, 2);
    const invoice = await choosePlan(f.db, f.tenantId, f.owner, planId, T0);
    const card = { method: 'card', payerEmail: 'p@mock.test', paymentMethodId: 'master', issuerId: '24', identificationType: 'CPF', identificationNumber: '123.456.789-09' };
    await assert.rejects(() => payInvoice(f.db, f.tenantId, invoice.id, { ...card, token: '' }, f.deps, T0), /cartão inválidos/);
    await assert.rejects(() => payInvoice(f.db, f.tenantId, invoice.id, { ...card, token: 'tok', identificationNumber: '123' }, f.deps, T0), /Documento/);

    f.mp.cardStatus('rejected');
    const refused = await payInvoice(f.db, f.tenantId, invoice.id, { ...card, token: 'tok-1' }, f.deps, T0);
    assert.deepEqual([refused.paymentStatus, refused.invoice.status], ['rejected', 'failed']);
    assert.equal((await f.entitlement()).status, 'none');
    const sent = f.mp.posts()[0].body!;
    assert.deepEqual([sent.token, sent.payment_method_id, sent.installments, sent.issuer_id, sent.payer], ['tok-1', 'master', 1, '24', { email: 'p@mock.test', identification: { type: 'CPF', number: '12345678909' } }]);

    f.mp.cardStatus('approved');
    const ok = await payInvoice(f.db, f.tenantId, invoice.id, { ...card, token: 'tok-2' }, f.deps, T0 + 1000);
    assert.deepEqual([ok.paymentStatus, ok.invoice.status], ['approved', 'paid']);
    assert.equal((await f.entitlement()).status, 'active');
    assert.notEqual(f.mp.posts()[0].key, f.mp.posts()[1].key, 'cartão novo = cobrança nova');
    // Fatura já paga: não cobra de novo.
    await payInvoice(f.db, f.tenantId, invoice.id, { ...card, token: 'tok-3' }, f.deps, T0 + 2000);
    assert.equal(f.mp.posts().length, 2);
});

test('trocar de plano substitui a fatura aberta; Pix antigo pago depois ainda é creditado pelo worker; plano menor que as lojas é recusado', async () => {
    const f = await fixture();
    const small = await f.plan('Básico', 5000, 1);
    const big = await f.plan('Pro', 9000, 3);
    const first = await choosePlan(f.db, f.tenantId, f.owner, small, T0);
    await f.payPix(first.id);
    const second = await choosePlan(f.db, f.tenantId, f.owner, big, T0 + 1000);
    const page = await getSubscriptionPage(f.db, f.tenantId, ENV);
    assert.deepEqual(page.invoices.map((i) => [i.planName, i.status]), [['Pro', 'pending'], ['Básico', 'cancelled']]);
    await assert.rejects(() => f.payPix(first.id, T0 + 2000), /substituída/);
    // O cliente pagou o QR antigo mesmo assim: o worker confere e credita o que foi pago.
    f.mp.set('5001', { status: 'approved' });
    await runSubscriptionCycle(f.db, f.deps.client!, T0 + 5 * 60 * 1000);
    const ent = await f.entitlement();
    assert.deepEqual([ent.status, ent.maxStores], ['active', 1]);

    await createStore(f.db, f.tenantId, { name: 'Loja 1' }, f.owner as never);
    await assert.rejects(() => dispatchCommand(f.db, f.tenantId, f.owner, ent, { type: 'store.create', data: { name: 'Loja 2' } } as never, T0 + 6 * 60 * 1000), /Limite de lojas/);
    const upgrade = await choosePlan(f.db, f.tenantId, f.owner, big, T0 + 7 * 60 * 1000);
    assert.notEqual(upgrade.id, second.id);
    await f.payPix(upgrade.id, T0 + 8 * 60 * 1000);
    f.mp.set('5002', { status: 'approved' });
    await checkInvoice(f.db, f.tenantId, upgrade.id, f.deps, T0 + 9 * 60 * 1000);
    const after = await f.entitlement();
    assert.equal(after.maxStores, 3);
    assert.equal(after.accessUntil, addOneMonth(addOneMonth(T0 + 5 * 60 * 1000)), 'mês pago soma ao período já pago');
    await createStore(f.db, f.tenantId, { name: 'Loja 2' }, f.owner as never);
    await assert.rejects(() => choosePlan(f.db, f.tenantId, f.owner, small, T0 + 10 * 60 * 1000), /2 lojas e o plano Básico permite 1/);
});

test('renovação: fatura gerada 7 dias antes do vencimento; sem pagamento, acesso termina no fim do período (zero tolerância)', async () => {
    const f = await fixture();
    const planId = await f.plan('Pro', 5000, 2);
    const invoice = await choosePlan(f.db, f.tenantId, f.owner, planId, T0);
    await f.payPix(invoice.id);
    f.mp.set('5001', { status: 'approved' });
    await checkInvoice(f.db, f.tenantId, invoice.id, f.deps, T0);
    const paidUntil = addOneMonth(T0);
    let cycle = await runSubscriptionCycle(f.db, f.deps.client!, paidUntil - 8 * DAY);
    assert.equal(cycle.renewals, 0, 'ainda longe do vencimento');
    cycle = await runSubscriptionCycle(f.db, f.deps.client!, paidUntil - 7 * DAY);
    assert.equal(cycle.renewals, 1);
    cycle = await runSubscriptionCycle(f.db, f.deps.client!, paidUntil - 6 * DAY);
    assert.equal(cycle.renewals, 0, 'não duplica a fatura de renovação');
    const renewal = (await getSubscriptionPage(f.db, f.tenantId, ENV)).invoices[0];
    assert.deepEqual([renewal.status, renewal.amountCents, renewal.dueDate], ['pending', 5000, paidUntil]);
    requireActive(await f.entitlement(), paidUntil - 1);
    await runSubscriptionCycle(f.db, f.deps.client!, paidUntil + 1);
    const ent = await f.entitlement();
    assert.equal(ent.status, 'expired');
    assert.throws(() => requireActive(ent, paidUntil + 1), /período de acesso terminou/);
    // Pagar a renovação depois do vencimento reabre por um mês a partir do pagamento.
    await f.payPix(renewal.id, paidUntil + DAY);
    f.mp.set('5002', { status: 'approved' });
    await runSubscriptionCycle(f.db, f.deps.client!, paidUntil + DAY + 2 * 60_000);
    const back = await f.entitlement();
    assert.deepEqual([back.status, back.accessUntil], ['active', addOneMonth(paidUntil + DAY + 2 * 60_000)]);
});

test('cancelar renovação: não gera novas faturas e o acesso vale até o fim do período pago', async () => {
    const f = await fixture();
    const planId = await f.plan('Pro', 5000, 2);
    const invoice = await choosePlan(f.db, f.tenantId, f.owner, planId, T0);
    await f.payPix(invoice.id);
    f.mp.set('5001', { status: 'approved' });
    await checkInvoice(f.db, f.tenantId, invoice.id, f.deps, T0);
    await assert.rejects(() => cancelRenewal(f.db, f.tenantId, { ...f.owner, userId: 'outro' }, T0 + 1000), /titular/);
    await cancelRenewal(f.db, f.tenantId, f.owner, T0 + 1000);
    await assert.rejects(() => cancelRenewal(f.db, f.tenantId, f.owner, T0 + 2000), /Não há assinatura ativa/);
    const paidUntil = addOneMonth(T0);
    const cycle = await runSubscriptionCycle(f.db, f.deps.client!, paidUntil - 3 * DAY);
    assert.equal(cycle.renewals, 0);
    let ent = await f.entitlement();
    assert.equal(ent.status, 'cancelled');
    requireActive(ent, paidUntil - 3 * DAY);
    await runSubscriptionCycle(f.db, f.deps.client!, paidUntil + 1);
    ent = await f.entitlement();
    assert.equal(ent.status, 'expired');
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

test('cadastro com plano: confere o plano antes de criar a conta e devolve a fatura para pagar na tela', async () => {
    const f = await fixture();
    const planId = await savePlatformPlan(f.db, ADMIN, { name: 'Essencial', priceCents: 9900, maxStores: 1, active: true, description: 'Para começar', features: ['PDV', 'Estoque', '', '  '].join('\n') }, ENV, T0);
    const options = await getSignupOptions(f.db, ENV);
    assert.deepEqual(options.plans.map((p) => [p.name, p.description, p.features]), [['Essencial', 'Para começar', ['PDV', 'Estoque']]]);
    assert.deepEqual(options.checkout, { pixEnabled: true, cardEnabled: false, publicKey: null }, 'cartão só com a chave pública');
    assert.deepEqual((await getSignupOptions(f.db, { ...ENV, PLATFORM_MP_PUBLIC_KEY: 'TEST-public-MOCK' })).checkout, { pixEnabled: true, cardEnabled: true, publicKey: 'TEST-public-MOCK' });
    const users = async () => Number((await f.db.prepare('SELECT COUNT(*) AS n FROM users').bind().first<{ n: number }>())?.n);
    const before = await users();
    const input = { accountName: 'Loja Nova', displayName: 'Ana', email: 'ana@nova.test', password: 'Test-only-password-123' };
    await assert.rejects(() => registerWithPlan(f.db, input, '203.0.113.9', ENV, T0), /Escolha um plano/);
    await assert.rejects(() => registerWithPlan(f.db, { ...input, planId }, '203.0.113.9', { PLATFORM_ADMIN_EMAILS: ADMIN }, T0), /indisponível/);
    assert.equal(await users(), before, 'nenhuma conta criada quando o plano ou a cobrança não estão ok');
    const r = await registerWithPlan(f.db, { ...input, planId }, '203.0.113.9', ENV, T0);
    assert.ok(r.token);
    assert.deepEqual([r.invoice?.status, r.invoice?.amountCents, r.invoice?.planName], ['pending', 9900, 'Essencial']);
    const acc = await f.db.prepare('SELECT a.subscription_status AS s FROM accounts a JOIN platform_invoices i ON i.account_id = a.id WHERE i.id = ?').bind(r.invoice!.id).first<{ s: string }>();
    assert.equal(acc?.s, 'none', 'só ativa depois do pagamento confirmado');
});

test('cadastro: administrador da plataforma não escolhe plano nem recebe fatura', async () => {
    const f = await fixture();
    const admin = await registerWithPlan(f.db, { accountName: 'Plataforma', displayName: 'Adm', email: ADMIN, password: 'Test-only-password-123' }, null, { PLATFORM_ADMIN_EMAILS: ADMIN }, T0);
    assert.equal(admin.invoice, null);
    assert.ok(admin.token);
});
