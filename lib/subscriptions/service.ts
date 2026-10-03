import { randomUUID } from 'node:crypto';
import { RuleError } from '../errors.ts';
import type { Actor, Entitlement } from '../domain.ts';
import { MercadoPagoClient, ProviderError, type FetchLike, type MpPreapproval } from '../payments/mercadopago.ts';
import { getSystemRole } from '../sales/discount.ts';
import { recordAudit } from '../audit/service.ts';
import { logger } from '../log.ts';

// Planos e assinaturas da plataforma (§43/§44 de instrucoes.md). Decisões do usuário (2026-10-03):
// cobrança automática pelo Mercado Pago, só mensal, único limite = lojas, planos cadastrados pelo
// administrador da plataforma na tela (nenhum pré-cadastrado), sem teste grátis, zero dias de
// tolerância e contas dos administradores da plataforma liberadas sem pagar.
//
// Configuração do servidor (nada presumido; sem ela a contratação fica desligada e a tela explica):
//   PLATFORM_MP_ACCESS_TOKEN   Access Token da conta Mercado Pago que recebe as mensalidades
//   PLATFORM_MP_WEBHOOK_SECRET segredo da assinatura (x-signature) do webhook dessa aplicação
//   PLATFORM_ADMIN_EMAILS      e-mails (separados por vírgula) dos administradores da plataforma
//   APP_URL                    endereço público do OmniHub (retorno do checkout)
//
// O acesso só é liberado por consulta autenticada ao Mercado Pago: fatura (authorized_payment) com
// pagamento "approved", da nossa assinatura e no valor contratado. Cada fatura paga vale um mês a
// partir da data da cobrança (plano mensal). O webhook só dispara essa consulta.

type Env = Record<string, string | undefined>;
const ADMIN_MAX_STORES_KEY = 'admin_max_stores';
const MAX_PLAN_STORES = 1000;
const MAX_PRICE_CENTS = 100_000_000;

export type SubscriptionDeps = { client: MercadoPagoClient | null; appUrl: string | null };

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
    const problems = ['PLATFORM_MP_ACCESS_TOKEN', 'PLATFORM_MP_WEBHOOK_SECRET', 'APP_URL'].filter((k) => !(env[k] ?? '').trim()).map((k) => `${k} não definida`);
    if (env.APP_URL) {
        try {
            const u = new URL(env.APP_URL.trim());
            const local = ['localhost', '127.0.0.1'].includes(u.hostname);
            if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) problems.push('APP_URL deve usar https');
        } catch {
            problems.push('APP_URL inválida');
        }
    }
    return problems;
}

export function subscriptionDepsFromEnv(env: Env = process.env, fetchImpl?: FetchLike): SubscriptionDeps {
    if (platformBillingProblems(env).length) return { client: null, appUrl: null };
    return { client: new MercadoPagoClient(env.PLATFORM_MP_ACCESS_TOKEN!.trim(), fetchImpl), appUrl: env.APP_URL!.trim().replace(/\/+$/, '') };
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

export type PlatformPlan = { id: string; name: string; priceCents: number; maxStores: number; active: boolean; createdAt: number; updatedAt: number };

function requirePlatformAdmin(email: string | null | undefined, env: Env): string {
    if (!isPlatformAdmin(email, env)) throw new RuleError('Acesso restrito aos administradores da plataforma.', 403);
    return String(email).trim().toLowerCase();
}

const mapPlan = (r: { id: string; name: string; priceCents: number; maxStores: number; active: number; createdAt: number; updatedAt: number }): PlatformPlan => ({
    id: r.id,
    name: r.name,
    priceCents: Number(r.priceCents),
    maxStores: Number(r.maxStores),
    active: Number(r.active) === 1,
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
});

export async function listPlatformPlans(db: D1Database, options: { onlyActive?: boolean } = {}): Promise<PlatformPlan[]> {
    const rows = await db
        .prepare(`SELECT id, name, price_cents AS priceCents, max_stores AS maxStores, active, created_at AS createdAt, updated_at AS updatedAt FROM platform_plans ${options.onlyActive ? 'WHERE active = 1' : ''} ORDER BY price_cents, name`)
        .bind()
        .all<{ id: string; name: string; priceCents: number; maxStores: number; active: number; createdAt: number; updatedAt: number }>();
    return (rows.results ?? []).map(mapPlan);
}

/** Cria ou edita um plano. Mudança de preço/limite vale só para novas assinaturas (cada assinatura guarda a sua cópia). */
export async function savePlatformPlan(db: D1Database, adminEmail: string | null, input: { id?: string; name: unknown; priceCents: unknown; maxStores: unknown; active: unknown }, env: Env = process.env, now = Date.now()): Promise<string> {
    const admin = requirePlatformAdmin(adminEmail, env);
    const name = String(input.name ?? '').trim();
    const priceCents = Number(input.priceCents);
    const maxStores = Number(input.maxStores);
    if (name.length < 2 || name.length > 60) throw new RuleError('Nome do plano: 2 a 60 caracteres.', 400);
    if (!Number.isSafeInteger(priceCents) || priceCents < 1 || priceCents > MAX_PRICE_CENTS) throw new RuleError('Informe o preço mensal do plano.', 400);
    if (!Number.isSafeInteger(maxStores) || maxStores < 1 || maxStores > MAX_PLAN_STORES) throw new RuleError(`Limite de lojas: 1 a ${MAX_PLAN_STORES}.`, 400);
    const active = input.active === false ? 0 : 1;
    const dup = await db.prepare('SELECT id FROM platform_plans WHERE lower(name) = lower(?) AND id <> ?').bind(name, input.id ?? '').first<{ id: string }>();
    if (dup) throw new RuleError('Já existe um plano com este nome.', 409);
    if (input.id) {
        const result = await db.prepare('UPDATE platform_plans SET name = ?, price_cents = ?, max_stores = ?, active = ?, updated_at = ? WHERE id = ?').bind(name, priceCents, maxStores, active, now, input.id).run();
        if (result.meta.changes !== 1) throw new RuleError('Plano não encontrado.', 404);
        logger.info('plataforma.plano.alterado', { planId: input.id, admin });
        return input.id;
    }
    const id = randomUUID();
    await db.prepare('INSERT INTO platform_plans (id, name, price_cents, max_stores, active, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, name, priceCents, maxStores, active, admin, now, now).run();
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

export async function getPlatformOverview(db: D1Database, adminEmail: string | null, env: Env = process.env): Promise<{ plans: PlatformPlan[]; adminMaxStores: number | null; accounts: PlatformAccount[]; billingProblems: string[]; webhookUrl: string | null }> {
    requirePlatformAdmin(adminEmail, env);
    const rows = await db
        .prepare(
            `SELECT a.id AS id, a.name AS name, a.subscription_status AS status, a.access_until AS accessUntil, a.max_stores AS maxStores, a.created_at AS createdAt,
                    (SELECT u.email FROM user_tenant_roles utr JOIN roles r ON r.id = utr.role_id JOIN users u ON u.id = utr.user_id WHERE utr.tenant_id = a.id AND r.name = 'OWNER' LIMIT 1) AS ownerEmail,
                    (SELECT COUNT(*) FROM stores s WHERE s.tenant_id = a.id) AS stores,
                    (SELECT s2.plan_name FROM account_subscriptions s2 WHERE s2.account_id = a.id ORDER BY s2.created_at DESC LIMIT 1) AS planName,
                    (SELECT s3.status FROM account_subscriptions s3 WHERE s3.account_id = a.id ORDER BY s3.created_at DESC LIMIT 1) AS subscriptionStatus
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
        webhookUrl: problems.length ? null : `${env.APP_URL!.trim().replace(/\/+$/, '')}/api/platform/subscriptions/webhook`,
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

// ---------------------------------------------------------------- assinatura da conta

type SubRow = {
    id: string; accountId: string; planId: string; planName: string; priceCents: number; maxStores: number; payerEmail: string;
    preapprovalId: string | null; initPoint: string | null; status: string; providerStatus: string; paidUntil: number; lastError: string; createdAt: number; updatedAt: number;
};
const SUB_COLUMNS = `id, account_id AS accountId, plan_id AS planId, plan_name AS planName, price_cents AS priceCents, max_stores AS maxStores, payer_email AS payerEmail,
    preapproval_id AS preapprovalId, init_point AS initPoint, status, provider_status AS providerStatus, paid_until AS paidUntil, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt`;
const OPEN_STATUSES = ['CREATING', 'PENDING', 'AUTHORIZED', 'PAUSED'];

export type SubscriptionView = { id: string; planName: string; priceCents: number; maxStores: number; payerEmail: string; status: string; paidUntil: number; initPoint: string | null; lastError: string; createdAt: number };

const normalize = (r: SubRow): SubRow => ({ ...r, priceCents: Number(r.priceCents), maxStores: Number(r.maxStores), paidUntil: Number(r.paidUntil), createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt) });

const toView = (r: SubRow): SubscriptionView => ({
    id: r.id, planName: r.planName, priceCents: Number(r.priceCents), maxStores: Number(r.maxStores), payerEmail: r.payerEmail, status: r.status,
    paidUntil: Number(r.paidUntil), initPoint: r.status === 'PENDING' ? r.initPoint : null, lastError: r.lastError, createdAt: Number(r.createdAt),
});

async function loadSub(db: D1Database, where: 'id' | 'preapproval_id', value: string): Promise<SubRow | null> {
    const row = await db.prepare(`SELECT ${SUB_COLUMNS} FROM account_subscriptions WHERE ${where} = ?`).bind(value).first<SubRow>();
    return row ? normalize(row) : null;
}

async function accountSubs(db: D1Database, tenantId: string): Promise<SubRow[]> {
    const rows = await db.prepare(`SELECT ${SUB_COLUMNS} FROM account_subscriptions WHERE account_id = ? ORDER BY created_at DESC`).bind(tenantId).all<SubRow>();
    return (rows.results ?? []).map(normalize);
}

async function requireOwner(db: D1Database, tenantId: string, actor: Actor): Promise<void> {
    if ((await getSystemRole(db, tenantId, actor.userId)) !== 'OWNER') throw new RuleError('Só o titular da conta contrata ou cancela a assinatura.', 403);
}

export async function getSubscriptionPage(db: D1Database, tenantId: string, env: Env = process.env): Promise<{ plans: PlatformPlan[]; subscriptions: SubscriptionView[]; billingReady: boolean }> {
    const [plans, subs] = await Promise.all([listPlatformPlans(db, { onlyActive: true }), accountSubs(db, tenantId)]);
    return { plans, subscriptions: subs.slice(0, 10).map(toView), billingReady: platformBillingProblems(env).length === 0 };
}

/** Um mês depois da cobrança (plano mensal); dia inexistente no mês seguinte vira o último dia. */
export function addOneMonth(ms: number): number {
    const d = new Date(ms);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** Grava na conta o que as assinaturas pagas garantem (fonte única lida por resolveEntitlement). */
async function applyToAccount(db: D1Database, tenantId: string, now: number): Promise<void> {
    const subs = (await accountSubs(db, tenantId)).filter((s) => s.paidUntil > 0);
    if (!subs.length) return; // nunca pagou: a conta continua como está (sem acesso, ou avaliação antiga)
    const accessUntil = Math.max(...subs.map((s) => s.paidUntil));
    // Limite de lojas: a assinatura vigente mais recente (troca de plano vale a partir do pagamento).
    const current = subs.find((s) => s.paidUntil > now) ?? subs.find((s) => s.paidUntil === accessUntil)!;
    const anyOpen = subs.some((s) => s.paidUntil > now && s.status !== 'CANCELLED');
    const status = accessUntil > now ? (anyOpen ? 'active' : 'cancelled') : 'expired';
    await db.prepare('UPDATE accounts SET subscription_status = ?, access_until = ?, max_stores = ? WHERE id = ?').bind(status, accessUntil, current.maxStores, tenantId).run();
}

function mapProviderStatus(status: string): string {
    return ({ pending: 'PENDING', authorized: 'AUTHORIZED', paused: 'PAUSED', cancelled: 'CANCELLED' } as Record<string, string>)[status] ?? 'PENDING';
}

/** Cancela no Mercado Pago e marca como cancelada (falha no provedor não marca nada). */
async function cancelSub(db: D1Database, sub: SubRow, client: MercadoPagoClient | null, now: number): Promise<void> {
    if (sub.preapprovalId && client) {
        try {
            await client.cancelPreapproval(sub.preapprovalId);
        } catch (error) {
            logger.error('assinatura.cancelamento_mp_falhou', { subscriptionId: sub.id, error });
            await db.prepare('UPDATE account_subscriptions SET last_error = ?, updated_at = ? WHERE id = ?').bind('Não foi possível cancelar no Mercado Pago; tente de novo.', now, sub.id).run();
            throw new RuleError('Não foi possível cancelar no Mercado Pago agora. Tente de novo em instantes.', 502);
        }
    }
    await db.prepare("UPDATE account_subscriptions SET status = 'CANCELLED', updated_at = ? WHERE id = ?").bind(now, sub.id).run();
}

/**
 * Consulta a assinatura e as faturas no Mercado Pago e atualiza o acesso. Só conta fatura com
 * pagamento "approved", da nossa assinatura (referência externa = id interno) e no valor contratado.
 */
export async function reconcileSubscription(db: D1Database, subscriptionId: string, client: MercadoPagoClient, now = Date.now()): Promise<SubscriptionView | null> {
    let sub = await loadSub(db, 'id', subscriptionId);
    if (!sub) return null;
    let pre: MpPreapproval | null;
    if (!sub.preapprovalId) {
        // Criação com resposta perdida: procura pela referência externa (mesmo id interno).
        pre = await client.findPreapprovalByReference(sub.id);
        if (!pre) {
            if (sub.status === 'CREATING' && now - sub.createdAt > 60 * 60 * 1000) {
                await db.prepare("UPDATE account_subscriptions SET status = 'FAILED', last_error = ?, updated_at = ?, last_checked_at = ? WHERE id = ?").bind('A assinatura não foi criada no Mercado Pago. Tente assinar de novo.', now, now, sub.id).run();
            } else {
                await db.prepare('UPDATE account_subscriptions SET last_checked_at = ? WHERE id = ?').bind(now, sub.id).run();
            }
            return toView((await loadSub(db, 'id', sub.id))!);
        }
        await db.prepare("UPDATE account_subscriptions SET preapproval_id = ?, init_point = ?, status = 'PENDING', updated_at = ? WHERE id = ?").bind(pre.id, pre.initPoint, now, sub.id).run();
        sub = (await loadSub(db, 'id', sub.id))!;
    } else {
        pre = await client.getPreapproval(sub.preapprovalId);
    }
    const current = sub;
    if (pre.externalReference !== current.id || pre.amountCents !== current.priceCents) {
        const msg = `Assinatura no Mercado Pago não confere (referência ${pre.externalReference || '-'}, valor ${pre.amountCents ?? '?'} x ${current.priceCents}). Acesso não liberado.`;
        await db.prepare('UPDATE account_subscriptions SET last_error = ?, provider_status = ?, updated_at = ?, last_checked_at = ? WHERE id = ?').bind(msg, pre.status, now, now, current.id).run();
        logger.error('assinatura.divergente', { subscriptionId: current.id, referencia: pre.externalReference, valor: pre.amountCents, esperado: current.priceCents });
        return toView((await loadSub(db, 'id', current.id))!);
    }
    const preId = pre.id;
    const invoices = await client.listInvoices(preId);
    const approved = invoices
        .filter((i) => i.preapprovalId === preId && i.paymentStatus === 'approved' && i.amountCents === current.priceCents && i.debitDate !== null)
        .sort((a, b) => (b.debitDate ?? 0) - (a.debitDate ?? 0));
    const paidUntil = Math.max(current.paidUntil, ...approved.map((i) => addOneMonth(i.debitDate!)));
    const status = current.status === 'CANCELLED' ? 'CANCELLED' : mapProviderStatus(pre.status);
    await db
        .prepare('UPDATE account_subscriptions SET status = ?, provider_status = ?, paid_until = ?, last_payment_id = COALESCE(?, last_payment_id), last_error = ?, updated_at = ?, last_checked_at = ? WHERE id = ?')
        .bind(status, pre.status, paidUntil, approved[0]?.paymentId || null, '', now, now, current.id)
        .run();
    // Primeiro pagamento desta assinatura: as outras assinaturas abertas da conta (troca de plano,
    // tentativa anterior não paga) são canceladas para não cobrar duas vezes.
    if (current.paidUntil === 0 && paidUntil > 0) {
        for (const other of await accountSubs(db, current.accountId)) {
            if (other.id === current.id || !OPEN_STATUSES.includes(other.status)) continue;
            await cancelSub(db, other, client, now).catch(() => undefined); // falha fica em last_error
        }
        await recordAudit(db, { tenantId: current.accountId, userId: 'system', operator: 'Mercado Pago', action: 'subscription.paid', description: `Assinatura do plano ${current.planName} paga`, entity: 'account_subscription', entityId: current.id, after: { paidUntil, planName: current.planName } }, now);
    }
    await applyToAccount(db, current.accountId, now);
    return toView((await loadSub(db, 'id', current.id))!);
}

/** Titular escolhe um plano: cria a assinatura no Mercado Pago e devolve o link de pagamento. */
export async function startSubscription(db: D1Database, tenantId: string, actor: Actor, input: { planId: unknown; payerEmail: unknown }, deps: SubscriptionDeps, now = Date.now()): Promise<{ subscriptionId: string; initPoint: string }> {
    if (!deps.client || !deps.appUrl) throw new RuleError('A cobrança das assinaturas ainda não foi configurada no servidor. Fale com o suporte do OmniHub.', 503);
    await requireOwner(db, tenantId, actor);
    const planId = String(input.planId ?? '');
    const plan = (await listPlatformPlans(db, { onlyActive: true })).find((p) => p.id === planId);
    if (!plan) throw new RuleError('Plano não encontrado ou indisponível.', 404);
    const payerEmail = String(input.payerEmail ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail) || payerEmail.length > 254) throw new RuleError('Informe o e-mail da conta Mercado Pago que vai pagar.', 400);
    const stores = await db.prepare('SELECT COUNT(*) AS n FROM stores WHERE tenant_id = ?').bind(tenantId).first<{ n: number }>();
    const storeCount = Number(stores?.n ?? 0);
    if (storeCount > plan.maxStores) throw new RuleError(`A conta tem ${storeCount} lojas e o plano ${plan.name} permite ${plan.maxStores}. Escolha um plano maior.`, 409);
    const subs = await accountSubs(db, tenantId);
    if (subs.some((s) => s.planId === plan.id && s.status === 'AUTHORIZED' && s.paidUntil > now)) throw new RuleError('Você já assina este plano.', 409);
    // Tentativas anteriores nunca pagas são substituídas por esta.
    for (const old of subs.filter((s) => (s.status === 'PENDING' || s.status === 'CREATING') && s.paidUntil === 0)) await cancelSub(db, old, deps.client, now).catch(() => undefined);

    const id = randomUUID();
    await db
        .prepare("INSERT INTO account_subscriptions (id, account_id, plan_id, plan_name, price_cents, max_stores, payer_email, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'CREATING',?,?,?)")
        .bind(id, tenantId, plan.id, plan.name, plan.priceCents, plan.maxStores, payerEmail, actor.userId, now, now)
        .run();
    let pre: MpPreapproval;
    try {
        pre = await deps.client.createPreapproval({ reason: `OmniHub - plano ${plan.name}`, externalReference: id, payerEmail, amountCents: plan.priceCents, backUrl: `${deps.appUrl}/?assinatura=retorno` }, id);
    } catch (error) {
        if (error instanceof ProviderError && !error.retryable) {
            await db.prepare("UPDATE account_subscriptions SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?").bind(error.message, now, id).run();
            throw new RuleError(error.message, 502);
        }
        // Resultado incerto: o worker procura pela referência externa e conclui (sem criar outra).
        await db.prepare('UPDATE account_subscriptions SET last_error = ?, updated_at = ? WHERE id = ?').bind('Comunicação com o Mercado Pago incerta; conferindo.', now, id).run();
        logger.error('assinatura.criacao_incerta', { subscriptionId: id, error });
        throw new RuleError('O Mercado Pago não respondeu. Aguarde um instante e atualize a página antes de tentar de novo.', 502);
    }
    await db.prepare("UPDATE account_subscriptions SET preapproval_id = ?, init_point = ?, status = 'PENDING', provider_status = ?, last_error = '', updated_at = ? WHERE id = ?").bind(pre.id, pre.initPoint, pre.status, now, id).run();
    await recordAudit(db, { tenantId, userId: actor.userId, operator: actor.displayName, action: 'subscription.start', description: `Assinatura do plano ${plan.name} iniciada`, entity: 'account_subscription', entityId: id, after: { planName: plan.name, priceCents: plan.priceCents, maxStores: plan.maxStores } }, now);
    return { subscriptionId: id, initPoint: pre.initPoint! };
}

/** Titular cancela: para as cobranças; o acesso continua até o fim do período já pago. */
export async function cancelAccountSubscription(db: D1Database, tenantId: string, actor: Actor, deps: SubscriptionDeps, now = Date.now()): Promise<void> {
    await requireOwner(db, tenantId, actor);
    const open = (await accountSubs(db, tenantId)).filter((s) => OPEN_STATUSES.includes(s.status));
    if (!open.length) throw new RuleError('Não há assinatura ativa para cancelar.', 404);
    if (open.some((s) => s.preapprovalId) && !deps.client) throw new RuleError('A cobrança das assinaturas não está configurada no servidor; não é possível cancelar no Mercado Pago agora.', 503);
    for (const sub of open) await cancelSub(db, sub, deps.client, now);
    await applyToAccount(db, tenantId, now);
    await recordAudit(db, { tenantId, userId: actor.userId, operator: actor.displayName, action: 'subscription.cancel', description: 'Assinatura cancelada pelo titular', entity: 'account_subscription', entityId: open[0].id }, now);
}

/** Webhook: com a assinatura x-signature já conferida, identifica a assinatura e consulta o Mercado Pago. */
export async function handlePlatformWebhook(db: D1Database, params: { type: string | null; dataId: string | null; signatureOk: boolean }, deps: SubscriptionDeps, now = Date.now()): Promise<number> {
    if (!deps.client) return 503;
    if (!params.signatureOk) return 401;
    if (!params.dataId) return 200;
    let preapprovalId: string | null = null;
    if (params.type === 'subscription_preapproval') preapprovalId = params.dataId;
    else if (params.type === 'subscription_authorized_payment') preapprovalId = (await deps.client.getInvoice(params.dataId)).preapprovalId || null;
    else return 200; // outros tópicos: aceitos e ignorados
    const sub = preapprovalId ? await loadSub(db, 'preapproval_id', preapprovalId) : null;
    if (!sub) return 200;
    await reconcileSubscription(db, sub.id, deps.client, now);
    return 200;
}

/** Worker: confere assinaturas abertas (webhook perdido, renovação, criação incerta). */
export async function reconcileOpenSubscriptions(db: D1Database, client: MercadoPagoClient, now = Date.now()): Promise<{ checked: number; failed: number }> {
    const rows = await db
        .prepare(
            `SELECT id FROM account_subscriptions
             WHERE (status IN ('CREATING','PENDING') AND created_at > ? AND (last_checked_at IS NULL OR last_checked_at < ?))
                OR (status IN ('AUTHORIZED','PAUSED') AND (paid_until < ? OR last_checked_at IS NULL OR last_checked_at < ?))
             ORDER BY updated_at LIMIT 50`,
        )
        .bind(now - 7 * 24 * 60 * 60 * 1000, now - 2 * 60 * 1000, now + 3 * 24 * 60 * 60 * 1000, now - 12 * 60 * 60 * 1000)
        .all<{ id: string }>();
    let failed = 0;
    for (const row of rows.results ?? []) {
        try {
            await reconcileSubscription(db, row.id, client, now);
        } catch (error) {
            failed++;
            logger.error('assinatura.reconciliacao_falhou', { subscriptionId: row.id, error });
            await db.prepare('UPDATE account_subscriptions SET last_checked_at = ? WHERE id = ?').bind(now, row.id).run();
        }
    }
    // Período pago vencido vira "expired" mesmo sem notícia do provedor (zero dias de tolerância).
    await db.prepare("UPDATE accounts SET subscription_status = 'expired' WHERE subscription_status IN ('active','cancelled') AND access_until <= ?").bind(now).run();
    return { checked: (rows.results ?? []).length, failed };
}

/** Atualiza as assinaturas abertas da conta (retorno do checkout / botão "Atualizar"). */
export async function refreshAccountSubscription(db: D1Database, tenantId: string, deps: SubscriptionDeps, now = Date.now()): Promise<void> {
    if (!deps.client) return;
    for (const sub of (await accountSubs(db, tenantId)).filter((s) => OPEN_STATUSES.includes(s.status)).slice(0, 3)) {
        try {
            await reconcileSubscription(db, sub.id, deps.client, now);
        } catch (error) {
            logger.error('assinatura.atualizacao_falhou', { subscriptionId: sub.id, error });
        }
    }
}
