import { logger } from './log.ts';

// Limpeza de registros de controle que só crescem. Nada de negócio é apagado (vendas, cobranças,
// contratos, auditoria ficam): só eventos de webhook já resolvidos e credenciais temporárias
// vencidas. Eventos ficam 90 dias como evidência de recebimento.
const DAY = 24 * 60 * 60 * 1000;
export const EVENT_RETENTION_MS = 90 * DAY;

export async function purgeOperationalData(db: D1Database, now = Date.now()): Promise<Record<string, number>> {
 const cutoff = now - EVENT_RETENTION_MS;
 const run = async (sql: string, ...binds: unknown[]) => Number((await db.prepare(sql).bind(...binds).run()).meta.changes ?? 0);
 return {
  // Adapter Sign: resolvidos, ou que esgotaram as tentativas (o worker não tenta mais).
  adapterSignEvents: await run("DELETE FROM adapter_sign_events WHERE received_at < ? AND (status IN ('PROCESSED','IGNORED') OR attempts >= 10)", cutoff),
  // Asaas: processados, esgotados ou que nunca corresponderam a uma cobrança do OmniHub.
  asaasEvents: await run("DELETE FROM asaas_events WHERE received_at < ? AND (status = 'PROCESSED' OR attempts >= 10 OR NOT EXISTS (SELECT 1 FROM order_receivables r WHERE r.store_id = asaas_events.store_id AND r.provider_id = asaas_events.payment_id))", cutoff),
  // Credenciais temporárias: desafios de login vencidos e links de senha vencidos ou usados.
  loginChallenges: await run('DELETE FROM login_challenges WHERE expires_at < ?', now),
  passwordResets: await run('DELETE FROM password_resets WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)', now, now - DAY),
 };
}

let timer: ReturnType<typeof setInterval> | undefined;
/** MAINTENANCE_INTERVAL_MS (padrão 6 h; 0 desliga). */
export function startMaintenanceWorker(db: D1Database): boolean {
 const ms = Number(process.env.MAINTENANCE_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
 if (timer || ms === 0) return false;
 if (!Number.isFinite(ms) || ms < 60_000) { logger.error('maintenance-worker.intervalo_invalido'); return false; }
 let running = false;
 timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
   const removed = await purgeOperationalData(db);
   if (Object.values(removed).some((n) => n > 0)) logger.info('maintenance.limpeza', removed);
  } catch (error) {
   logger.error('maintenance.erro', { error });
  } finally {
   running = false;
  }
 }, ms);
 timer.unref();
 return true;
}
