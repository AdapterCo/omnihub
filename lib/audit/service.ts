// Trilha de auditoria (§42): AuditLog imutável para ações importantes. Campos exigidos
// pela especificação: tenant, loja, usuário, ação, entidade, ID, data/hora, IP quando
// apropriado, informações anteriores/posteriores, correlation ID. "Não armazenar segredos
// nos logs" — por isso `sanitizeForAudit` remove chaves conhecidas (senha, pfx, csc etc.)
// antes de serializar `before`/`after`, e cada chamador é responsável por nunca passar um
// segredo bruto em `before`/`after`.
const SECRET_KEYS = new Set(['passphrase', 'pfxbase64', 'pfxbuffer', 'csc', 'password', 'senha', 'privatekeypem', 'certbase64']);

function sanitizeForAudit(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(sanitizeForAudit);
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            if (SECRET_KEYS.has(key.toLowerCase())) {
                out[key] = '[REDACTED]';
            } else {
                out[key] = sanitizeForAudit(val);
            }
        }
        return out;
    }
    return value;
}

export type AuditEntry = {
    id: string;
    at: number;
    userId: string;
    operator: string;
    action: string;
    description: string;
    storeId?: string;
    entity?: string | null;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
    correlationId?: string | null;
};

export async function recordAudit(
    db: D1Database,
    params: {
        tenantId: string;
        storeId?: string;
        userId: string;
        operator: string;
        action: string;
        description: string;
        entity?: string;
        entityId?: string;
        before?: unknown;
        after?: unknown;
        ip?: string | null;
        correlationId?: string | null;
    },
    now = Date.now(),
): Promise<void> {
    const beforeJson = params.before !== undefined ? JSON.stringify(sanitizeForAudit(params.before)) : null;
    const afterJson = params.after !== undefined ? JSON.stringify(sanitizeForAudit(params.after)) : null;

    await db
        .prepare(
            `INSERT INTO audit_logs (
                 id, tenant_id, store_id, user_id, operator, action, description,
                 entity, entity_id, before_data, after_data, ip, correlation_id, created_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
            crypto.randomUUID(),
            params.tenantId,
            params.storeId ?? null,
            params.userId,
            params.operator,
            params.action,
            params.description,
            params.entity ?? null,
            params.entityId ?? null,
            beforeJson,
            afterJson,
            params.ip ?? null,
            params.correlationId ?? null,
            now,
        )
        .run();
}

export async function listAudit(db: D1Database, tenantId: string): Promise<AuditEntry[]> {
    const rows = await db
        .prepare(
            `SELECT id, created_at AS at, user_id AS userId, operator, action, description, store_id AS storeId,
                    entity, entity_id AS entityId, before_data AS beforeData, after_data AS afterData, ip, correlation_id AS correlationId
             FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC`,
        )
        .bind(tenantId)
        .all<{
            id: string; at: number; userId: string; operator: string; action: string; description: string; storeId: string | null;
            entity: string | null; entityId: string | null; beforeData: string | null; afterData: string | null; ip: string | null; correlationId: string | null;
        }>();

    return (rows.results ?? []).map((r) => ({
        id: r.id,
        at: r.at,
        userId: r.userId,
        operator: r.operator,
        action: r.action,
        description: r.description,
        storeId: r.storeId ?? undefined,
        entity: r.entity,
        entityId: r.entityId,
        before: r.beforeData ? JSON.parse(r.beforeData) : undefined,
        after: r.afterData ? JSON.parse(r.afterData) : undefined,
        ip: r.ip,
        correlationId: r.correlationId,
    }));
}
