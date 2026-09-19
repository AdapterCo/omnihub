import { RuleError } from '../errors.ts';
import { loadPermissions, requirePermission } from '../authz/service.ts';
import { checkCredentials } from '../auth/service.ts';
import { assertNotLocked, recordHit, resetBucket, type RateRule } from '../auth/rateLimit.ts';
import type { Actor } from '../domain.ts';

// Descontos (instrucoes.md §53): "OPERADOR: até X%, GERENTE: até Y%, ADMIN: configurável.
// Desconto superior ao permitido deverá solicitar autorização. Registrar quem concedeu e
// quem autorizou." X e Y NÃO estão definidos na especificação — por isso nenhum percentual
// é presumido aqui: o limite de cada papel vem de `discount_limits` (configurado pelo
// admin) e, sem linha, é 0. Só o OWNER (acesso administrativo completo, §4) não tem teto.
//
// Todo valor é inteiro: dinheiro em centavos, percentual em pontos-base (1% = 100 bp), para
// nunca haver erro de ponto flutuante em cálculo de desconto.

export const OWNER_ROLE = 'OWNER';
export const MAX_DISCOUNT_BP = 10000;
/** Papéis cujo limite pode ser configurado. OWNER é ilimitado; ESTOQUISTA/CONSULTA não vendem. */
export const CONFIGURABLE_ROLES = ['ADMIN', 'GERENTE', 'OPERADOR_CAIXA'] as const;
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

// Tentativas de senha de supervisor: mesma proteção do login (5 erros = 15 min de bloqueio).
const SUPERVISOR_RULE: RateRule = { max: 5, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 };

export type DiscountRequest = { percent?: number; amount?: number; reason: string };
export type SupervisorAuthorization = { email: string; password: string };

/** Percentual (até 2 casas decimais) -> pontos-base. */
export function percentToBasisPoints(percent: number): number {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new RuleError('Percentual de desconto inválido (use 0 a 100).', 400);
    const bp = Math.round(percent * 100);
    if (Math.abs(bp / 100 - percent) > 1e-9) throw new RuleError('O percentual aceita no máximo 2 casas decimais.', 400);
    return bp;
}

/** Maior desconto (centavos) permitido sobre `gross` para um limite em pontos-base. */
export function maxDiscountCents(gross: number, limitBp: number): number {
    return Math.floor((gross * limitBp) / 10000);
}

/**
 * Converte o pedido (percentual OU valor) em centavos. Nunca zera nem passa do total:
 * a venda precisa continuar com valor a receber (pagamento exige valor positivo).
 */
export function computeDiscountCents(gross: number, request: DiscountRequest): number {
    const hasPercent = request.percent !== undefined;
    const hasAmount = request.amount !== undefined;
    if (hasPercent === hasAmount) throw new RuleError('Informe o desconto em percentual OU em valor (nunca os dois).', 400);
    const cents = hasPercent ? maxDiscountCents(gross, percentToBasisPoints(request.percent as number)) : (request.amount as number);
    if (!Number.isSafeInteger(cents) || cents < 1) throw new RuleError('O desconto informado é zero ou inválido.', 400);
    if (cents >= gross) throw new RuleError('O desconto não pode igualar ou superar o total da venda.', 400);
    if (!request.reason || request.reason.trim().length < 3) throw new RuleError('Informe o motivo do desconto (mín. 3 caracteres) — ele fica registrado na venda.', 400);
    return cents;
}

/**
 * Rateia o desconto entre as linhas proporcionalmente ao valor de cada uma (método do
 * maior resto: a soma é exatamente `discount` e nenhuma linha recebe mais que o próprio valor).
 * A NF-e/NFC-e precisa do desconto por item (vDesc).
 */
export function allocateDiscount(lines: { price: number; qty: number }[], discount: number): number[] {
    const grosses = lines.map((l) => l.price * l.qty);
    const gross = grosses.reduce((a, b) => a + b, 0);
    if (discount <= 0 || gross <= 0) return grosses.map(() => 0);
    const base = grosses.map((g) => Math.floor((g * discount) / gross));
    let leftover = discount - base.reduce((a, b) => a + b, 0);
    const order = grosses
        .map((g, index) => ({ index, remainder: (g * discount) % gross }))
        .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (const { index } of order) {
        if (leftover <= 0) break;
        if (base[index] < grosses[index]) {
            base[index] += 1;
            leftover -= 1;
        }
    }
    return base;
}

/** Papel de sistema do usuário no tenant (OWNER, ADMIN, GERENTE...), ou null se não for membro. */
export async function getSystemRole(db: D1Database, tenantId: string, userId: string): Promise<string | null> {
    const row = await db
        .prepare('SELECT r.name AS name FROM user_tenant_roles utr JOIN roles r ON r.id = utr.role_id WHERE utr.user_id = ? AND utr.tenant_id = ?')
        .bind(userId, tenantId)
        .first<{ name: string }>();
    return row?.name ?? null;
}

/** Limite (pontos-base) de um papel na conta: OWNER = 100%; sem configuração = 0 (nada presumido). */
export async function getDiscountLimitBp(db: D1Database, tenantId: string, role: string | null): Promise<number> {
    if (!role) return 0;
    if (role === OWNER_ROLE) return MAX_DISCOUNT_BP;
    const row = await db.prepare('SELECT max_bp AS maxBp FROM discount_limits WHERE tenant_id = ? AND role = ?').bind(tenantId, role).first<{ maxBp: number }>();
    return row ? Number(row.maxBp) : 0;
}

export type DiscountLimitView = { role: ConfigurableRole; maxBp: number; configured: boolean };

/** Limites configuráveis da conta (para a tela de configuração). Exige SALE_DISCOUNT_CONFIG. */
export async function listDiscountLimits(db: D1Database, tenantId: string, actor: Actor): Promise<DiscountLimitView[]> {
    requirePermission(actor.permissions, 'SALE_DISCOUNT_CONFIG');
    const rows = await db.prepare('SELECT role, max_bp AS maxBp FROM discount_limits WHERE tenant_id = ?').bind(tenantId).all<{ role: string; maxBp: number }>();
    const byRole = new Map((rows.results ?? []).map((r) => [r.role, Number(r.maxBp)]));
    return CONFIGURABLE_ROLES.map((role) => ({ role, maxBp: byRole.get(role) ?? 0, configured: byRole.has(role) }));
}

export async function saveDiscountLimits(
    db: D1Database,
    tenantId: string,
    limits: { role: string; percent: number }[],
    actor: Actor,
    now = Date.now(),
): Promise<DiscountLimitView[]> {
    requirePermission(actor.permissions, 'SALE_DISCOUNT_CONFIG');
    // Valida a lista INTEIRA antes de gravar qualquer linha e grava numa transação só: uma
    // lista com um item inválido não pode deixar um limite salvo pela metade.
    const seen = new Set<string>();
    const validated = limits.map((limit) => {
        if (!(CONFIGURABLE_ROLES as readonly string[]).includes(limit.role)) throw new RuleError(`O limite do papel "${limit.role}" não é configurável.`, 400);
        if (seen.has(limit.role)) throw new RuleError('Papel repetido na lista de limites.', 400);
        seen.add(limit.role);
        return { role: limit.role, bp: percentToBasisPoints(limit.percent) };
    });
    await db.batch(
        validated.map((limit) =>
            db
                .prepare(
                    `INSERT INTO discount_limits (tenant_id, role, max_bp, updated_by, updated_at) VALUES (?,?,?,?,?)
                     ON CONFLICT (tenant_id, role) DO UPDATE SET max_bp = excluded.max_bp, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
                )
                .bind(tenantId, limit.role, limit.bp, actor.userId, now),
        ),
    );
    return listDiscountLimits(db, tenantId, actor);
}

export type DiscountAuthority = { authorizedBy: { userId: string; name: string } | null };

/**
 * Decide se o desconto pode ser concedido. Dentro do limite do próprio operador: livre.
 * Acima dele: exige a autorização de OUTRO usuário da conta que tenha SALE_DISCOUNT e
 * limite suficiente, identificado por e-mail + senha (padrão de "senha de supervisor"),
 * com bloqueio por tentativas. Sem autorização informada, responde 428 para a tela pedir.
 */
export async function resolveDiscountAuthority(
    db: D1Database,
    tenantId: string,
    actor: Actor,
    discountCents: number,
    gross: number,
    authorization: SupervisorAuthorization | undefined,
    now = Date.now(),
): Promise<DiscountAuthority> {
    const actorRole = await getSystemRole(db, tenantId, actor.userId);
    const actorLimitBp = await getDiscountLimitBp(db, tenantId, actorRole);
    if (discountCents <= maxDiscountCents(gross, actorLimitBp)) return { authorizedBy: null };

    if (!authorization) {
        const limitText = `${(actorLimitBp / 100).toFixed(2).replace('.', ',')}%`;
        throw new RuleError(`Este desconto passa do seu limite (${limitText}). É necessária a autorização de um supervisor.`, 428);
    }

    const bucket = `discount-auth:user:${actor.userId}`;
    await assertNotLocked(db, bucket, now);
    const denied = async () => {
        await recordHit(db, bucket, SUPERVISOR_RULE, now);
        return new RuleError('Credenciais de supervisor inválidas ou sem alçada para este desconto.', 403);
    };

    const supervisor = await checkCredentials(db, authorization.email, authorization.password);
    if (!supervisor || supervisor.id === actor.userId) throw await denied();
    const membership = await db.prepare('SELECT role FROM memberships WHERE user_id = ? AND account_id = ?').bind(supervisor.id, tenantId).first<{ role: string }>();
    const supervisorRole = await getSystemRole(db, tenantId, supervisor.id);
    if (!membership || !supervisorRole) throw await denied();
    const permissions = await loadPermissions(db, supervisor.id, tenantId, membership.role);
    if (!permissions.has('SALE_DISCOUNT')) throw await denied();
    const supervisorLimitBp = await getDiscountLimitBp(db, tenantId, supervisorRole);
    if (discountCents > maxDiscountCents(gross, supervisorLimitBp)) throw await denied();

    await resetBucket(db, bucket);
    return { authorizedBy: { userId: supervisor.id, name: supervisor.displayName } };
}
