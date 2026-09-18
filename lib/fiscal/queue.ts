import { randomUUID } from 'node:crypto';
import { RuleError } from '../errors.ts';
import { requirePermission, loadPermissions } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import { transmitNFe, cancelNFeDocument } from './service.ts';
import { SefazDirectGateway, type FiscalGateway } from './gateway.ts';

// Processamento assíncrono fiscal (§41): "Operações fiscais externas podem demorar ou
// falhar. Preparar arquitetura com filas/workers." Fila baseada no D1 (decisão do
// usuário nesta sessão — não há Cloudflare Queues configurado no projeto e eu não posso
// inventar bindings de infraestrutura que não foram confirmados).
//
// API → enqueueFiscalJob (grava fiscal_jobs) → runFiscalJobWorker (claim + processa,
// chamado sob demanda) → transmitNFe/cancelNFeDocument (mesmas funções síncronas já
// testadas) → SEFAZ → resultado.
//
// LIMITAÇÃO EXPLÍCITA, NÃO ESCONDIDA: este projeto (vinext/Cloudflare Workers) gera o
// `wrangler.json` automaticamente no build (`dist/server/wrangler.json`) — não há um
// `wrangler.toml` editável no repositório para eu adicionar um Cron Trigger real sem
// adivinhar configuração de infraestrutura. Por isso `runFiscalJobWorker` é exposto via
// comando autenticado (`fiscal.jobs.process`), disparável manualmente pela UI ou por um
// agendador externo que chame a API — não roda sozinho em background nesta entrega.
//
// Retry/backoff/dead-letter (§41): backoff exponencial com teto de 30 min, até
// `maxAttempts` tentativas (padrão 5) antes de mover para DEAD_LETTER. "Nunca retries
// cegos que possam gerar duplicidade": se o job falhar mas o documento já tiver alcançado
// o estado desejado (ex.: já AUTHORIZED/CANCELLED — outra tentativa anterior teve sucesso
// mas o job não foi marcado a tempo), o worker reconhece isso como sucesso em vez de
// tentar de novo ou marcar como falha.

export type FiscalJobType = 'TRANSMIT_NFE' | 'CANCEL_NFE';
export type FiscalJobStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTER';

export type FiscalJobSummary = {
    id: string;
    jobType: FiscalJobType;
    saleId: string | null;
    storeId: string | null;
    status: FiscalJobStatus;
    attempts: number;
    maxAttempts: number;
    nextAttemptAt: number;
    lastError: string | null;
    createdAt: number;
    updatedAt: number;
};

type FiscalJobRow = FiscalJobSummary & { tenantId: string; userId: string; payload: string; correlationId: string | null };

function backoffMs(attempts: number): number {
    return Math.min(30_000 * 2 ** attempts, 30 * 60_000);
}

export async function enqueueFiscalJob(
    db: D1Database,
    tenantId: string,
    params: {
        jobType: FiscalJobType;
        saleId?: string;
        storeId?: string;
        payload?: Record<string, unknown>;
        userId: string;
        correlationId?: string | null;
        maxAttempts?: number;
    },
    now = Date.now(),
): Promise<string> {
    const idempotencyKey = `${params.jobType}:${params.saleId ?? params.storeId}`;
    const id = randomUUID();
    const payloadJson = JSON.stringify(params.payload ?? {});
    const maxAttempts = params.maxAttempts ?? 5;

    // Idempotência (§41): a mesma chave nunca cria dois jobs pendentes/em processamento.
    // Só permite reenfileirar se o job anterior já terminou (sucesso, falha ou dead-letter).
    await db
        .prepare(
            `INSERT INTO fiscal_jobs (
                 id, tenant_id, job_type, sale_id, store_id, payload, status, attempts, max_attempts,
                 next_attempt_at, last_error, user_id, correlation_id, idempotency_key, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, NULL, ?, ?, ?, ?, ?)
             ON CONFLICT(tenant_id, idempotency_key) DO UPDATE SET
                 status = 'PENDING', attempts = 0, last_error = NULL, next_attempt_at = excluded.next_attempt_at,
                 payload = excluded.payload, user_id = excluded.user_id, correlation_id = excluded.correlation_id,
                 updated_at = excluded.updated_at
             WHERE fiscal_jobs.status IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTER')`,
        )
        .bind(id, tenantId, params.jobType, params.saleId ?? null, params.storeId ?? null, payloadJson, maxAttempts, now, params.userId, params.correlationId ?? null, idempotencyKey, now, now)
        .run();

    const row = await db.prepare(`SELECT id FROM fiscal_jobs WHERE tenant_id = ? AND idempotency_key = ?`).bind(tenantId, idempotencyKey).first<{ id: string }>();
    return row!.id;
}

async function claimNextFiscalJob(db: D1Database, now = Date.now()): Promise<FiscalJobRow | null> {
    const row = await db
        .prepare(
            `UPDATE fiscal_jobs SET status = 'PROCESSING', updated_at = ?
             WHERE id = (SELECT id FROM fiscal_jobs WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT 1)
             RETURNING id, tenant_id AS tenantId, job_type AS jobType, sale_id AS saleId, store_id AS storeId,
                       payload, status, attempts, max_attempts AS maxAttempts, next_attempt_at AS nextAttemptAt,
                       last_error AS lastError, user_id AS userId, correlation_id AS correlationId,
                       created_at AS createdAt, updated_at AS updatedAt`,
        )
        .bind(now, now)
        .first<FiscalJobRow>();
    return row ?? null;
}

async function reloadActor(db: D1Database, tenantId: string, userId: string): Promise<Actor> {
    const membership = await db
        .prepare(`SELECT role, store_id AS storeId, display_name AS displayName FROM memberships WHERE user_id = ? AND account_id = ?`)
        .bind(userId, tenantId)
        .first<{ role: string; storeId: string | null; displayName: string }>();
    if (!membership) {
        throw new RuleError('Usuário que enfileirou o job não tem mais vínculo com o tenant — não é seguro reprocessar sem uma sessão válida.', 404);
    }
    const permissions = await loadPermissions(db, userId, tenantId, membership.role);
    return { userId, displayName: membership.displayName, role: membership.role, storeId: membership.storeId, permissions };
}

export async function runFiscalJobWorker(
    db: D1Database,
    gateway: FiscalGateway = new SefazDirectGateway(),
    options: { batchSize?: number } = {},
    now = Date.now(),
): Promise<{ processed: number; succeeded: number; failed: number; deadLettered: number }> {
    const batchSize = options.batchSize ?? 10;
    let processed = 0, succeeded = 0, failed = 0, deadLettered = 0;

    for (let i = 0; i < batchSize; i++) {
        const job = await claimNextFiscalJob(db, now);
        if (!job) break;
        processed++;

        try {
            const actor = await reloadActor(db, job.tenantId, job.userId);
            const payload = JSON.parse(job.payload) as Record<string, unknown>;

            if (job.jobType === 'TRANSMIT_NFE') {
                if (!job.saleId) throw new RuleError('Job de transmissão sem saleId.', 500);
                await transmitNFe(db, job.tenantId, job.saleId, actor, gateway, now);
            } else if (job.jobType === 'CANCEL_NFE') {
                if (!job.saleId) throw new RuleError('Job de cancelamento sem saleId.', 500);
                await cancelNFeDocument(db, job.tenantId, job.saleId, String(payload.justification ?? ''), actor, gateway, now);
            }

            await db.prepare(`UPDATE fiscal_jobs SET status = 'SUCCEEDED', updated_at = ? WHERE id = ?`).bind(now, job.id).run();
            succeeded++;
        } catch (err) {
            // Nunca retry cego que gere duplicidade (§41): se o estado desejado já foi
            // alcançado por uma tentativa anterior, trata como sucesso em vez de tentar de
            // novo ou marcar como falha.
            const goalAlreadyReached = job.saleId ? await checkGoalAlreadyReached(db, job.tenantId, job.saleId, job.jobType) : false;
            if (goalAlreadyReached) {
                await db.prepare(`UPDATE fiscal_jobs SET status = 'SUCCEEDED', updated_at = ? WHERE id = ?`).bind(now, job.id).run();
                succeeded++;
                continue;
            }

            const attempts = job.attempts + 1;
            const message = err instanceof Error ? err.message : String(err);
            if (attempts >= job.maxAttempts) {
                await db.prepare(`UPDATE fiscal_jobs SET status = 'DEAD_LETTER', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`).bind(attempts, message, now, job.id).run();
                deadLettered++;
            } else {
                await db
                    .prepare(`UPDATE fiscal_jobs SET status = 'PENDING', attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
                    .bind(attempts, message, now + backoffMs(attempts), now, job.id)
                    .run();
            }
            failed++;
        }
    }

    return { processed, succeeded, failed, deadLettered };
}

async function checkGoalAlreadyReached(db: D1Database, tenantId: string, saleId: string, jobType: FiscalJobType): Promise<boolean> {
    const doc = await db.prepare(`SELECT status FROM fiscal_documents WHERE tenant_id = ? AND sale_id = ?`).bind(tenantId, saleId).first<{ status: string }>();
    if (!doc) return false;
    if (jobType === 'TRANSMIT_NFE') return doc.status === 'AUTHORIZED';
    if (jobType === 'CANCEL_NFE') return doc.status === 'CANCELLED';
    return false;
}

/** Observabilidade (§41): contagem por status + jobs em dead-letter mais recentes. */
export async function getFiscalJobsSummary(db: D1Database, tenantId: string, actor: Actor): Promise<{ byStatus: Record<FiscalJobStatus, number>; deadLetters: FiscalJobSummary[] }> {
    requirePermission(actor.permissions, 'FISCAL_VIEW');

    const statusRows = await db
        .prepare(`SELECT status, COUNT(*) AS count FROM fiscal_jobs WHERE tenant_id = ? GROUP BY status`)
        .bind(tenantId)
        .all<{ status: FiscalJobStatus; count: number }>();

    const byStatus: Record<FiscalJobStatus, number> = { PENDING: 0, PROCESSING: 0, SUCCEEDED: 0, FAILED: 0, DEAD_LETTER: 0 };
    for (const r of statusRows.results ?? []) byStatus[r.status] = r.count;

    const deadLetterRows = await db
        .prepare(
            `SELECT id, job_type AS jobType, sale_id AS saleId, store_id AS storeId, status, attempts, max_attempts AS maxAttempts,
                    next_attempt_at AS nextAttemptAt, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
             FROM fiscal_jobs WHERE tenant_id = ? AND status = 'DEAD_LETTER' ORDER BY updated_at DESC LIMIT 20`,
        )
        .bind(tenantId)
        .all<FiscalJobSummary>();

    return { byStatus, deadLetters: deadLetterRows.results ?? [] };
}
