import { RuleError } from '../errors.ts';

// Limite de tentativas persistido no banco (vale entre várias instâncias e sobrevive a
// restart). Cada "bucket" conta ocorrências numa janela; ao passar do máximo fica travado
// por `lockMs`. Contas de e-mail podem ser travadas por terceiros (5 erros trancam 15 min) —
// é o custo aceito para impedir adivinhação de senha.
export type RateRule = { max: number; windowMs: number; lockMs: number };

const MINUTE = 60 * 1000;
export const LOGIN_EMAIL_RULE: RateRule = { max: 5, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE };
export const LOGIN_IP_RULE: RateRule = { max: 20, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE };
export const REGISTER_IP_RULE: RateRule = { max: 5, windowMs: 60 * MINUTE, lockMs: 60 * MINUTE };

export async function assertNotLocked(db: D1Database, bucket: string, now = Date.now()): Promise<void> {
    const row = await db.prepare('SELECT locked_until AS lockedUntil FROM auth_rate_limits WHERE bucket = ?').bind(bucket).first<{ lockedUntil: number }>();
    if (row && Number(row.lockedUntil) > now) {
        const minutes = Math.max(1, Math.ceil((Number(row.lockedUntil) - now) / MINUTE));
        throw new RuleError(`Muitas tentativas. Tente novamente em ${minutes} minuto(s).`, 429);
    }
}

/** Conta uma ocorrência no bucket; trava se ultrapassar o máximo da janela. */
export async function recordHit(db: D1Database, bucket: string, rule: RateRule, now = Date.now()): Promise<void> {
    const row = await db
        .prepare(
            `INSERT INTO auth_rate_limits (bucket, count, window_start, locked_until) VALUES (?, 1, ?, 0)
             ON CONFLICT (bucket) DO UPDATE SET
               count = CASE WHEN auth_rate_limits.window_start + ? <= ? THEN 1 ELSE auth_rate_limits.count + 1 END,
               window_start = CASE WHEN auth_rate_limits.window_start + ? <= ? THEN ? ELSE auth_rate_limits.window_start END
             RETURNING count`,
        )
        .bind(bucket, now, rule.windowMs, now, rule.windowMs, now, now)
        .first<{ count: number }>();
    if (row && Number(row.count) >= rule.max) {
        await db.prepare('UPDATE auth_rate_limits SET locked_until = ? WHERE bucket = ?').bind(now + rule.lockMs, bucket).run();
    }
}

export async function resetBucket(db: D1Database, bucket: string): Promise<void> {
    await db.prepare('DELETE FROM auth_rate_limits WHERE bucket = ?').bind(bucket).run();
}

/** Limpeza barata de dados de autenticação vencidos (sessões e contadores antigos). */
export async function purgeExpiredAuthData(db: D1Database, now = Date.now()): Promise<void> {
    await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
    await db.prepare('DELETE FROM auth_rate_limits WHERE locked_until < ? AND window_start < ?').bind(now, now - 24 * 60 * MINUTE).run();
}
