import { createHash, randomUUID } from 'node:crypto';
import { RuleError } from '../errors.ts';
import type { Actor, Entitlement } from '../domain.ts';
import { MercadoPagoClient, ProviderError, centsToAmount, type FetchLike } from '../payments/mercadopago.ts';
import { getSystemRole } from '../sales/discount.ts';
import { guardedRegister, isRegistrationEnabled } from '../auth/service.ts';
import { recordAudit } from '../audit/service.ts';
import { logger } from '../log.ts';

// Planos e assinaturas da plataforma (§43/§44 de instrucoes.md). Decisões do usuário (2026-10-03):
// cobrança automática pelo Mercado Pago, só mensal, único limite = lojas, planos cadastrados pelo
// administrador da plataforma na tela (nenhum pré-cadastrado), sem teste grátis, zero dias de
// tolerância e contas dos administradores da plataforma liberadas sem pagar.
//
// Pagamento como no Adapter Connect: o cliente escolhe o plano e paga na própria tela, por Pix (QR
// Code) ou cartão de crédito/débito (formulário seguro do Mercado Pago). Cada mês é uma fatura.
//
// Configuração do servidor (nada presumido; sem ela a contratação fica desligada e a tela explica):
//   PLATFORM_MP_ACCESS_TOKEN   Access Token da conta Mercado Pago que recebe as mensalidades
//   PLATFORM_MP_PUBLIC_KEY     chave pública da mesma aplicação (formulário de cartão; sem ela, só Pix)
//   PLATFORM_ADMIN_EMAILS      e-mails (separados por vírgula) dos administradores da plataforma
//
// O acesso só é liberado por consulta autenticada ao Mercado Pago (GET /v1/payments/{id}): pagamento
// "approved", desta fatura (referência externa) e no valor dela. Cada fatura paga vale um mês. Sem
// webhook (decisão do usuário): a tela consulta enquanto o cliente espera e o worker confere sozinho.

type Env = Record<string, string | undefined>;
const ADMIN_MAX_STORES_KEY = 'admin_max_stores';
const MAX_PLAN_STORES = 1000;
const MAX_PRICE_CENTS = 100_000_000;

export type SubscriptionDeps = { client: MercadoPagoClient | null };

export function platformAdminEmails(env: Env = process.env): Set<string> {
    return new Set(
        (env.PLATFORM_ADMIN_EMAILS ?? '')
            .split(',')
            .map((e) => e.trim().toLowerCase())
            .filter((e) => e.includes('@')),
    );
}

export function isPlatformAdmin(email: string | null | undefined, env: Env = process.env): boolean {
    return !!email && platformAdminEmails(env).has(email.trim().toLowerCase());
}

/** O que falta na configuração do servidor para cobrar as assinaturas. */
export function platformBillingProblems(env: Env = process.env): string[] {
    return (env.PLATFORM_MP_ACCESS_TOKEN ?? '').trim() ? [] : ['PLATFORM_MP_ACCESS_TOKEN não definida'];
}

export function subscriptionDepsFromEnv(env: Env = process.env, fetchImpl?: FetchLike): SubscriptionDeps {
    const token = (env.PLATFORM_MP_ACCESS_TOKEN ?? '').trim();
    return { client: token ? new MercadoPagoClient(token, fetchImpl) : null };
}

// ---------------------------------------------------------------- acesso (EntitlementService)

async function ownerEmail(db: D1Database, tenantId: string): Promise<string | null> {
    const row = await db
        .prepare("SELECT u.email AS email FROM user_tenant_roles utr JOIN roles r ON r.id = utr.role_id JOIN users u ON u.id = utr.user_id WHERE utr.tenant_id = ? AND r.name = 'OWNER'")
        .bind(tenantId)
        .first<{ email: string | null }>();
    return row?.email ?? null;
}

async function getSetting(db: D1Database, key: string): Promise<string | null> {
    const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(key).first<{ value: string }>();
    return row?.value ?? null;
}

/**
 * Ponto único que decide o acesso da conta (§44: "não hardcodar regras de plano em dezenas de
 * controllers"). Conta de administrador da plataforma: liberada, com o limite de lojas definido no
 * painel (sem limite definido = 0 lojas, nada presumido). Demais: o que a assinatura gravou na conta.
 */
export async function resolveEntitlement(db: D1Database, tenantId: string, base: Entitlement, env: Env = process.env): Promise<Entitlement & { platform: boolean }> {
    if (isPlatformAdmin(await ownerEmail(db, tenantId), env)) {
        const raw = await getSetting(db, ADMIN_MAX_STORES_KEY);
        return { status: 'platform', accessUntil: Number.MAX_SAFE_INTEGER, maxStores: raw === null ? 0 : Number(raw), platform: true };
    }
    return { status: base.status, accessUntil: Number(base.accessUntil), maxStores: Number(base.maxStores), platform: false };
}

// ---------------------------------------------------------------- painel da plataforma

export type PlatformPlan = { id: string; name: string; priceCents: number; maxStores: number; description: string; features: string[]; active: boolean; createdAt: number; updatedAt: number };

function requirePlatformAdmin(email: string | null | undefined, env: Env): string {
    if (!isPlatformAdmin(email, env)) throw new RuleError('Acesso restrito aos administradores da plataforma.', 403);
    return String(email).trim().toLowerCase();
}

type PlanRow = { id: string; name: string; priceCents: number; maxStores: number; description: string; features: string; active: number; createdAt: number; updatedAt: number };
const mapPlan = (r: PlanRow): PlatformPlan => ({
    id: r.id,
    name: r.name,
    priceCents: Number(r.priceCents),
    maxStores: Number(r.maxStores),
    description: r.description ?? '',
    features: String(r.features ?? '').split('\n').map((f) => f.trim()).filter(Boolean),
    active: Number(r.active) === 1,
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
});

export async function listPlatformPlans(db: D1Database, options: { onlyActive?: boolean } = {}): Promise<PlatformPlan[]> {
    const rows = await db
        .prepare(`SELECT id, name, price_cents AS priceCents, max_stores AS maxStores, description, features, active, created_at AS createdAt, updated_at AS updatedAt FROM platform_plans ${options.onlyActive ? 'WHERE active = 1' : ''} ORDER BY price_cents, name`)
        .bind()
        .all<PlanRow>();
    return (rows.results ?? []).map(mapPlan);
}

/** Cria ou edita um plano. Mudança de preço/limite vale só para novas assinaturas (cada assinatura guarda a sua cópia). */
export async function savePlatformPlan(db: D1Database, adminEmail: string | null, input: { id?: string; name: unknown; priceCents: unknown; maxStores: unknown; active: unknown; description?: unknown; features?: unknown }, env: Env = process.env, now = Date.now()): Promise<string> {
    const admin = requirePlatformAdmin(adminEmail, env);
    const name = String(input.name ?? '').trim();
    const priceCents = Number(input.priceCents);
    const maxStores = Number(input.maxStores);
    if (name.length < 2 || name.length > 60) throw new RuleError('Nome do plano: 2 a 60 caracteres.', 400);
    if (!Number.isSafeInteger(priceCents) || priceCents < 1 || priceCents > MAX_PRICE_CENTS) throw new RuleError('Informe o preço mensal do plano.', 400);
    if (!Number.isSafeInteger(maxStores) || maxStores < 1 || maxStores > MAX_PLAN_STORES) throw new RuleError(`Limite de lojas: 1 a ${MAX_PLAN_STORES}.`, 400);
    const active = input.active === false ? 0 : 1;
    const description = String(input.description ?? '').trim();
    if (description.length > 300) throw new RuleError('Descrição do plano: no máximo 300 caracteres.', 400);
    const featureList = (Array.isArray(input.features) ? input.features.map(String) : String(input.features ?? '').split('\n')).map((f) => f.trim()).filter(Boolean);
    if (featureList.length > 15 || featureList.some((f) => f.length > 80)) throw new RuleError('Recursos do plano: até 15 linhas de até 80 caracteres.', 400);
    const features = featureList.join('\n');
    const dup = await db.prepare('SELECT id FROM platform_plans WHERE lower(name) = lower(?) AND id <> ?').bind(name, input.id ?? '').first<{ id: string }>();
    if (dup) throw new RuleError('Já existe um plano com este nome.', 409);
    if (input.id) {
        const result = await db.prepare('UPDATE platform_plans SET name = ?, price_cents = ?, max_stores = ?, description = ?, features = ?, active = ?, updated_at = ? WHERE id = ?').bind(name, priceCents, maxStores, description, features, active, now, input.id).run();
        if (result.meta.changes !== 1) throw new RuleError('Plano não encontrado.', 404);
        logger.info('plataforma.plano.alterado', { planId: input.id, admin });
        return input.id;
    }
    const id = randomUUID();
    await db.prepare('INSERT INTO platform_plans (id, name, price_cents, max_stores, description, features, active, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id, name, priceCents, maxStores, description, features, active, admin, now, now).run();
    logger.info('plataforma.plano.criado', { planId: id, admin });
    return id;
}

export async function setAdminMaxStores(db: D1Database, adminEmail: string | null, value: unknown, env: Env = process.env, now = Date.now()): Promise<void> {
    const admin = requirePlatformAdmin(adminEmail, env);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_PLAN_STORES) throw new RuleError(`Limite de lojas: 0 a ${MAX_PLAN_STORES}.`, 400);
    await db.batch([
        db.prepare('DELETE FROM platform_settings WHERE key = ?').bind(ADMIN_MAX_STORES_KEY),
        db.prepare('INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)').bind(ADMIN_MAX_STORES_KEY, String(n), admin, now),
    ]);
}

export type PlatformAccount = { id: string; name: string; ownerEmail: string; status: string; accessUntil: number; maxStores: number; stores: number; planName: string; subscriptionStatus: string; createdAt: number; platform: boolean };

export async function getPlatformOverview(db: D1Database, adminEmail: string | null, env: Env = process.env): Promise<{ plans: PlatformPlan[]; adminMaxStores: number | null; accounts: PlatformAccount[]; billingProblems: string[] }> {
    requirePlatformAdmin(adminEmail, env);
    const rows = await db
        .prepare(
            `SELECT a.id AS id, a.name AS name, a.subscription_status AS status, a.access_until AS accessUntil, a.max_stores AS maxStores, a.created_at AS createdAt,
                    (SELECT u.email FROM user_tenant_roles utr JOIN roles r ON r.id = utr.role_id JOIN users u ON u.id = utr.user_id WHERE utr.tenant_id = a.id AND r.name = 'OWNER' LIMIT 1) AS ownerEmail,
                    (SELECT COUNT(*) FROM stores s WHERE s.tenant_id = a.id) AS stores,
                    (SELECT i2.plan_name FROM platform_invoices i2 WHERE i2.account_id = a.id AND i2.status = 'paid' ORDER BY i2.paid_at DESC LIMIT 1) AS planName,
                    (SELECT i3.status FROM platform_invoices i3 WHERE i3.account_id = a.id ORDER BY i3.created_at DESC LIMIT 1) AS subscriptionStatus
             FROM accounts a ORDER BY a.created_at DESC LIMIT 500`,
        )
        .bind()
        .all<{ id: string; name: string; status: string; accessUntil: number; maxStores: number; createdAt: number; ownerEmail: string | null; stores: number; planName: string | null; subscriptionStatus: string | null }>();
    const raw = await getSetting(db, ADMIN_MAX_STORES_KEY);
    const problems = platformBillingProblems(env);
    return {
        plans: await listPlatformPlans(db),
        adminMaxStores: raw === null ? null : Number(raw),
        billingProblems: problems,
        accounts: (rows.results ?? []).map((r) => ({
            id: r.id,
            name: r.name,
            ownerEmail: r.ownerEmail ?? '',
            status: r.status,
            accessUntil: Number(r.accessUntil),
            maxStores: Number(r.maxStores),
            stores: Number(r.stores),
            planName: r.planName ?? '',
            subscriptionStatus: r.subscriptionStatus ?? '',
            createdAt: Number(r.createdAt),
            platform: isPlatformAdmin(r.ownerEmail, env),
        })),
    };
}

// ---------------------------------------------------------------- faturas do plano (Pix ou cartão na tela)

type InvoiceRow = {
    id: string; accountId: string; planId: string; planName: string; amountCents: number; maxStores: number; status: string; paymentMethod: string;
    mpPaymentId: string | null; mpStatus: string; mpStatusDetail: string; periodEnd: number | null; dueDate: number; paidAt: number | null; createdAt: number;
};
const INVOICE_COLUMNS = `id, account_id AS accountId, plan_id AS planId, plan_name AS planName, amount_cents AS amountCents, max_stores AS maxStores, status,
    payment_method AS paymentMethod, mp_payment_id AS mpPaymentId, mp_status AS mpStatus, mp_status_detail AS mpStatusDetail, period_end AS periodEnd,
    due_date AS dueDate, paid_at AS paidAt, created_at AS createdAt`;
const normalizeInvoice = (r: InvoiceRow): InvoiceRow => ({ ...r, amountCents: Number(r.amountCents), maxStores: Number(r.maxStores), dueDate: Number(r.dueDate), createdAt: Number(r.createdAt), periodEnd: r.periodEnd === null ? null : Number(r.periodEnd), paidAt: r.paidAt === null ? null : Number(r.paidAt) });

export type InvoiceView = { id: string; planName: string; amountCents: number; maxStores: number; status: string; paymentMethod: string; paymentStatusDetail: string; dueDate: number; paidAt: number | null; periodEnd: number | null; createdAt: number };
const toInvoiceView = (r: InvoiceRow): InvoiceView => ({ id: r.id, planName: r.planName, amountCents: r.amountCents, maxStores: r.maxStores, status: r.status, paymentMethod: r.paymentMethod, paymentStatusDetail: r.mpStatusDetail, dueDate: r.dueDate, paidAt: r.paidAt, periodEnd: r.periodEnd, createdAt: r.createdAt });

async function loadInvoice(db: D1Database, id: string): Promise<InvoiceRow | null> {
    const row = await db.prepare(`SELECT ${INVOICE_COLUMNS} FROM platform_invoices WHERE id = ?`).bind(id).first<InvoiceRow>();
    return row ? normalizeInvoice(row) : null;
}

async function accountInvoices(db: D1Database, tenantId: string): Promise<InvoiceRow[]> {
    const rows = await db.prepare(`SELECT ${INVOICE_COLUMNS} FROM platform_invoices WHERE account_id = ? ORDER BY created_at DESC`).bind(tenantId).all<InvoiceRow>();
    return (rows.results ?? []).map(normalizeInvoice);
}

async function requireOwner(db: D1Database, tenantId: string, actor: Actor): Promise<void> {
    if ((await getSystemRole(db, tenantId, actor.userId)) !== 'OWNER') throw new RuleError('Só o titular da conta escolhe o plano e paga.', 403);
}

/** Um mês depois (plano mensal); dia inexistente no mês seguinte vira o último dia. */
export function addOneMonth(ms: number): number {
    const d = new Date(ms);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

export type CheckoutConfig = { pixEnabled: boolean; cardEnabled: boolean; publicKey: string | null };
export function checkoutConfig(env: Env = process.env): CheckoutConfig {
    const token = !!(env.PLATFORM_MP_ACCESS_TOKEN ?? '').trim();
    const publicKey = (env.PLATFORM_MP_PUBLIC_KEY ?? '').trim() || null;
    return { pixEnabled: token, cardEnabled: token && !!publicKey, publicKey: token ? publicKey : null };
}

export async function getSubscriptionPage(db: D1Database, tenantId: string, env: Env = process.env): Promise<{ plans: PlatformPlan[]; invoices: InvoiceView[]; billingReady: boolean; checkout: CheckoutConfig }> {
    const [plans, invoices] = await Promise.all([listPlatformPlans(db, { onlyActive: true }), accountInvoices(db, tenantId)]);
    return { plans, invoices: invoices.slice(0, 12).map(toInvoiceView), billingReady: platformBillingProblems(env).length === 0, checkout: checkoutConfig(env) };
}

async function insertInvoice(db: D1Database, tenantId: string, plan: { id: string; name: string; priceCents: number; maxStores: number }, dueDate: number, createdBy: string, now: number): Promise<InvoiceRow> {
    const id = randomUUID();
    await db
        .prepare("INSERT INTO platform_invoices (id, account_id, plan_id, plan_name, amount_cents, max_stores, status, due_date, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,'pending',?,?,?,?)")
        .bind(id, tenantId, plan.id, plan.name, plan.priceCents, plan.maxStores, dueDate, createdBy, now, now)
        .run();
    return (await loadInvoice(db, id))!;
}

/** Titular escolhe um plano: gera a fatura do mês para pagar na tela (Pix ou cartão). */
export async function choosePlan(db: D1Database, tenantId: string, actor: Actor, planIdInput: unknown, now = Date.now()): Promise<InvoiceView> {
    await requireOwner(db, tenantId, actor);
    const plan = (await listPlatformPlans(db, { onlyActive: true })).find((p) => p.id === String(planIdInput ?? ''));
    if (!plan) throw new RuleError('Plano não encontrado ou indisponível.', 404);
    const stores = Number((await db.prepare('SELECT COUNT(*) AS n FROM stores WHERE tenant_id = ?').bind(tenantId).first<{ n: number }>())?.n ?? 0);
    if (stores > plan.maxStores) throw new RuleError(`A conta tem ${stores} lojas e o plano ${plan.name} permite ${plan.maxStores}. Escolha um plano maior.`, 409);
    // A nova escolha substitui a fatura em aberto. Se um Pix/cartão dela ainda for aprovado, o worker
    // continua conferindo e credita o mês pago (ver runSubscriptionCycle) — o dinheiro nunca se perde.
    await db.prepare("UPDATE platform_invoices SET status = 'cancelled', updated_at = ? WHERE account_id = ? AND status IN ('pending','failed')").bind(now, tenantId).run();
    const invoice = await insertInvoice(db, tenantId, plan, now, actor.userId, now);
    await recordAudit(db, { tenantId, userId: actor.userId, operator: actor.displayName, action: 'subscription.plan', description: `Plano ${plan.name} escolhido`, entity: 'platform_invoice', entityId: invoice.id, after: { planName: plan.name, amountCents: plan.priceCents } }, now);
    return toInvoiceView(invoice);
}

export type PaymentInput = { method?: unknown; payerEmail?: unknown; token?: unknown; paymentMethodId?: unknown; issuerId?: unknown; identificationType?: unknown; identificationNumber?: unknown };
export type PaymentResult = { invoice: InvoiceView; paymentStatus: string; paymentStatusDetail: string; qrCode: string | null; qrCodeBase64: string | null; ticketUrl: string | null };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** Paga a fatura por Pix (gera QR Code) ou cartão (token do formulário seguro do Mercado Pago). */
export async function payInvoice(db: D1Database, tenantId: string, invoiceId: string, input: PaymentInput, deps: SubscriptionDeps, now = Date.now()): Promise<PaymentResult> {
    if (!deps.client) throw new RuleError('O pagamento online ainda não foi configurado. Tente mais tarde.', 503);
    const invoice = await loadInvoice(db, invoiceId);
    if (!invoice || invoice.accountId !== tenantId) throw new RuleError('Fatura não encontrada.', 404);
    if (invoice.status === 'paid') return { invoice: toInvoiceView(invoice), paymentStatus: 'approved', paymentStatusDetail: '', qrCode: null, qrCodeBase64: null, ticketUrl: null };
    if (invoice.status === 'cancelled') throw new RuleError('Esta fatura foi substituída. Atualize a página.', 409);
    const method = String(input.method ?? '');
    if (method !== 'pix' && method !== 'card') throw new RuleError('Escolha Pix ou cartão.', 400);
    const payerEmail = String(input.payerEmail ?? '').trim().toLowerCase();
    if (!EMAIL.test(payerEmail)) throw new RuleError('Informe o e-mail do pagador.', 400);
    const body: Record<string, unknown> = {
        transaction_amount: Number(centsToAmount(invoice.amountCents)),
        description: `OmniHub - plano ${invoice.planName}`,
        external_reference: invoice.id,
        payer: { email: payerEmail },
    };
    let fingerprint = 'pix';
    if (method === 'pix') {
        body.payment_method_id = 'pix';
    } else {
        const token = String(input.token ?? '');
        const paymentMethodId = String(input.paymentMethodId ?? '');
        if (!token || token.length > 512 || !/^[a-zA-Z0-9_-]{1,80}$/.test(paymentMethodId)) throw new RuleError('Dados do cartão inválidos. Confira e tente de novo.', 400);
        body.token = token;
        body.payment_method_id = paymentMethodId;
        body.installments = 1;
        if (input.issuerId !== undefined && input.issuerId !== null && input.issuerId !== '') {
            if (!/^[0-9]{1,20}$/.test(String(input.issuerId))) throw new RuleError('Emissor do cartão inválido.', 400);
            body.issuer_id = String(input.issuerId);
        }
        const docType = String(input.identificationType ?? ''), docNumber = String(input.identificationNumber ?? '').replace(/\D/g, '');
        if (docType || docNumber) {
            if (!['CPF', 'CNPJ'].includes(docType) || docNumber.length !== (docType === 'CPF' ? 11 : 14)) throw new RuleError('Documento do pagador inválido.', 400);
            (body.payer as Record<string, unknown>).identification = { type: docType, number: docNumber };
        }
        fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 32);
    }
    // Mesma fatura + mesma forma (+ mesmo cartão tokenizado): repetir não gera outra cobrança.
    let payment;
    try {
        payment = await deps.client.createPayment(body, `${invoice.id}-${method}-${fingerprint}`);
    } catch (error) {
        // Mostra o motivo do Mercado Pago na tela; repetir é seguro (mesma chave de idempotência).
        if (error instanceof ProviderError) throw new RuleError(error.message, error.status === 0 || error.status >= 500 ? 503 : 422);
        throw error;
    }
    await db
        .prepare("UPDATE platform_invoices SET payment_method = ?, mp_payment_id = ?, mp_status = ?, mp_status_detail = ?, status = CASE WHEN status = 'paid' THEN status ELSE 'pending' END, updated_at = ? WHERE id = ?")
        .bind(method, payment.id, payment.status, payment.statusDetail, now, invoice.id)
        .run();
    if (payment.status === 'approved' || payment.status === 'rejected') await confirmInvoicePayment(db, invoice.id, deps.client, now);
    const updated = (await loadInvoice(db, invoice.id))!;
    return { invoice: toInvoiceView(updated), paymentStatus: payment.status, paymentStatusDetail: payment.statusDetail, qrCode: payment.qrCode, qrCodeBase64: payment.qrCodeBase64, ticketUrl: payment.ticketUrl };
}

/**
 * Consulta o pagamento no Mercado Pago (única fonte de verdade) e, aprovado, libera um mês de
 * acesso. Só conta pagamento desta fatura (referência externa) e no valor dela.
 */
export async function confirmInvoicePayment(db: D1Database, invoiceId: string, client: MercadoPagoClient, now = Date.now()): Promise<InvoiceView | null> {
    const invoice = await loadInvoice(db, invoiceId);
    if (!invoice || !invoice.mpPaymentId) return invoice ? toInvoiceView(invoice) : null;
    const payment = await client.getPayment(invoice.mpPaymentId);
    await db.prepare('UPDATE platform_invoices SET mp_status = ?, mp_status_detail = ?, last_checked_at = ? WHERE id = ?').bind(payment.status, payment.statusDetail, now, invoice.id).run();
    if (payment.externalReference !== invoice.id || payment.amountCents !== invoice.amountCents) {
        logger.error('assinatura.pagamento_divergente', { invoiceId: invoice.id, referencia: payment.externalReference, valor: payment.amountCents, esperado: invoice.amountCents });
        return toInvoiceView((await loadInvoice(db, invoice.id))!);
    }
    if (payment.status === 'approved' && invoice.status !== 'paid') {
        const account = await db.prepare('SELECT subscription_status AS status, access_until AS accessUntil FROM accounts WHERE id = ?').bind(invoice.accountId).first<{ status: string; accessUntil: number }>();
        const prepaid = account && ['active', 'cancelled'].includes(account.status) ? Number(account.accessUntil) : 0;
        const periodEnd = addOneMonth(Math.max(now, prepaid));
        // Reivindica a fatura: consultas simultâneas não liberam dois meses.
        const claimed = await db.prepare("UPDATE platform_invoices SET status = 'paid', paid_at = ?, period_end = ?, updated_at = ? WHERE id = ? AND status <> 'paid'").bind(now, periodEnd, now, invoice.id).run();
        if (claimed.meta.changes === 1) {
            await db.prepare("UPDATE accounts SET subscription_status = 'active', access_until = ?, max_stores = ? WHERE id = ?").bind(periodEnd, invoice.maxStores, invoice.accountId).run();
            await recordAudit(db, { tenantId: invoice.accountId, userId: 'system', operator: 'Mercado Pago', action: 'subscription.paid', description: `Plano ${invoice.planName} pago até ${new Date(periodEnd).toISOString().slice(0, 10)}`, entity: 'platform_invoice', entityId: invoice.id, after: { periodEnd, planName: invoice.planName } }, now);
        }
    } else if (['rejected', 'cancelled'].includes(payment.status) && invoice.status === 'pending') {
        await db.prepare("UPDATE platform_invoices SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, invoice.id).run();
    }
    return toInvoiceView((await loadInvoice(db, invoice.id))!);
}

/** Tela consultando se o pagamento já foi confirmado. */
export async function checkInvoice(db: D1Database, tenantId: string, invoiceId: string, deps: SubscriptionDeps, now = Date.now()): Promise<InvoiceView> {
    const invoice = await loadInvoice(db, invoiceId);
    if (!invoice || invoice.accountId !== tenantId) throw new RuleError('Fatura não encontrada.', 404);
    if (invoice.status === 'paid' || !invoice.mpPaymentId || !deps.client) return toInvoiceView(invoice);
    try {
        return (await confirmInvoicePayment(db, invoice.id, deps.client, now)) ?? toInvoiceView(invoice);
    } catch (error) {
        logger.error('assinatura.consulta_pagamento_falhou', { invoiceId: invoice.id, error });
        return toInvoiceView(invoice);
    }
}

/** Titular cancela a renovação: não gera novas faturas; o acesso vale até o fim do período pago. */
export async function cancelRenewal(db: D1Database, tenantId: string, actor: Actor, now = Date.now()): Promise<void> {
    await requireOwner(db, tenantId, actor);
    const result = await db.prepare("UPDATE accounts SET subscription_status = 'cancelled' WHERE id = ? AND subscription_status = 'active'").bind(tenantId).run();
    if (result.meta.changes !== 1) throw new RuleError('Não há assinatura ativa para cancelar.', 404);
    await db.prepare("UPDATE platform_invoices SET status = 'cancelled', updated_at = ? WHERE account_id = ? AND status IN ('pending','failed')").bind(now, tenantId).run();
    await recordAudit(db, { tenantId, userId: actor.userId, operator: actor.displayName, action: 'subscription.cancel', description: 'Renovação cancelada pelo titular', entity: 'account', entityId: tenantId }, now);
}

/**
 * Worker: confere pagamentos em andamento (inclusive de fatura substituída por outra escolha de plano,
 * por 7 dias: Pix pago depois ainda credita o mês), gera a fatura de renovação a 7 dias do vencimento
 * (contas ativas, com o plano da última fatura paga) e expira quem passou do período pago.
 */
export async function runSubscriptionCycle(db: D1Database, client: MercadoPagoClient, now = Date.now()): Promise<{ checked: number; renewals: number; failed: number }> {
    const pending = await db
        .prepare(
            `SELECT id FROM platform_invoices
             WHERE mp_payment_id IS NOT NULL AND (last_checked_at IS NULL OR last_checked_at < ?)
               AND (status = 'pending' OR (status = 'cancelled' AND mp_status IN ('pending','in_process','authorized') AND updated_at > ?))
             ORDER BY updated_at LIMIT 50`,
        )
        .bind(now - 60_000, now - 7 * 24 * 60 * 60 * 1000)
        .all<{ id: string }>();
    let failed = 0;
    for (const row of pending.results ?? []) {
        try {
            await confirmInvoicePayment(db, row.id, client, now);
        } catch (error) {
            failed++;
            logger.error('assinatura.reconciliacao_falhou', { invoiceId: row.id, error });
            await db.prepare('UPDATE platform_invoices SET last_checked_at = ? WHERE id = ?').bind(now, row.id).run();
        }
    }
    let renewals = 0;
    const due = await db
        .prepare(
            `SELECT a.id AS id, a.access_until AS accessUntil FROM accounts a
             WHERE a.subscription_status = 'active' AND a.access_until <= ?
               AND NOT EXISTS (SELECT 1 FROM platform_invoices i WHERE i.account_id = a.id AND i.status IN ('pending','failed'))
             LIMIT 100`,
        )
        .bind(now + 7 * 24 * 60 * 60 * 1000)
        .all<{ id: string; accessUntil: number }>();
    for (const account of due.results ?? []) {
        const last = (await accountInvoices(db, account.id)).find((i) => i.status === 'paid');
        if (!last) continue;
        const current = (await listPlatformPlans(db, { onlyActive: true })).find((p) => p.id === last.planId);
        const plan = current ?? { id: last.planId, name: last.planName, priceCents: last.amountCents, maxStores: last.maxStores };
        await insertInvoice(db, account.id, plan, Number(account.accessUntil), 'system', now);
        renewals++;
    }
    // Zero dias de tolerância: passou do período pago, a conta vence.
    await db.prepare("UPDATE accounts SET subscription_status = 'expired' WHERE subscription_status IN ('active','cancelled') AND access_until <= ?").bind(now).run();
    return { checked: (pending.results ?? []).length, renewals, failed };
}

// ---------------------------------------------------------------- cadastro com plano (modelo Adapter Connect)

/** O que a página de cadastro mostra: planos disponíveis e as formas de pagamento ligadas. */
export async function getSignupOptions(db: D1Database, env: Env = process.env): Promise<{ plans: PlatformPlan[]; billingReady: boolean; registrationEnabled: boolean; checkout: CheckoutConfig }> {
    return { plans: await listPlatformPlans(db, { onlyActive: true }), billingReady: platformBillingProblems(env).length === 0, registrationEnabled: isRegistrationEnabled(env), checkout: checkoutConfig(env) };
}

/**
 * Cria a conta já com o plano escolhido e a fatura do primeiro mês, para pagar na mesma tela (Pix ou
 * cartão). Plano conferido ANTES de criar a conta. Sem pagamento confirmado, a conta não tem acesso.
 * Administradores da plataforma não escolhem plano.
 */
export async function registerWithPlan(
    db: D1Database,
    input: { accountName: string; displayName: string; email: string; password: string; planId?: unknown },
    ip: string | null,
    env: Env = process.env,
    now = Date.now(),
): Promise<{ token: string; expiresAt: number; invoice: InvoiceView | null }> {
    const admin = isPlatformAdmin(input.email, env);
    let plan: PlatformPlan | undefined;
    if (!admin) {
        if (platformBillingProblems(env).length) throw new RuleError('A contratação online está indisponível no momento. Tente mais tarde.', 503);
        plan = (await listPlatformPlans(db, { onlyActive: true })).find((p) => p.id === String(input.planId ?? ''));
        if (!plan) throw new RuleError('Escolha um plano para criar a conta.', 400);
    }
    const reg = await guardedRegister(db, { accountName: input.accountName, displayName: input.displayName, email: input.email, password: input.password }, ip, now, env);
    if (admin || !plan) return { token: reg.token, expiresAt: reg.expiresAt, invoice: null };
    const invoice = await insertInvoice(db, reg.accountId, plan, now, reg.userId, now);
    return { token: reg.token, expiresAt: reg.expiresAt, invoice: toInvoiceView(invoice) };
}
