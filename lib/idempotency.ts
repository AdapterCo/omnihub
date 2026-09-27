import { RuleError } from './errors.ts';

// Idempotência (§31) para comandos relacionais. Mesma chave + mesmo comando -> mesmo resultado;
// mesma chave + comando diferente -> rejeitado. A chave é RESERVADA antes de executar: duas
// requisições simultâneas com a mesma chave (reenvio de rede, clique repetido com conexão lenta)
// nunca executam o comando duas vezes — a segunda recebe "em andamento".
type IdempotencyRow = { fingerprint: string; resultId: string | null; completedAt: number | null };

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
let lastPurge = 0;

export async function withIdempotency<T extends string | undefined>(
 db: D1Database,
 tenantId: string,
 key: string,
 fingerprint: string,
 run: () => Promise<T>,
 now = Date.now(),
): Promise<{ resultId: T | string | undefined; replayed: boolean }> {
 const reserved = await db
  .prepare('INSERT INTO command_idempotency (tenant_id, key, fingerprint, result_id, created_at, completed_at) VALUES (?,?,?,NULL,?,NULL) ON CONFLICT (tenant_id, key) DO NOTHING')
  .bind(tenantId, key, fingerprint, now)
  .run();
 if (reserved.meta.changes !== 1) {
  const existing = await db
   .prepare('SELECT fingerprint, result_id AS resultId, completed_at AS completedAt FROM command_idempotency WHERE tenant_id = ? AND key = ?')
   .bind(tenantId, key)
   .first<IdempotencyRow>();
  if (!existing) throw new RuleError('Operação em andamento. Aguarde e atualize a tela.', 409);
  if (existing.fingerprint !== fingerprint) throw new RuleError('Identificador de operação já utilizado.', 409);
  if (existing.completedAt == null) throw new RuleError('Esta operação já está sendo processada. Aguarde e atualize a tela.', 409);
  return { resultId: existing.resultId ?? undefined, replayed: true };
 }
 let resultId: T;
 try {
  resultId = await run();
 } catch (error) {
  // O comando falhou (nada foi gravado por ele): libera a chave para uma nova tentativa.
  await db.prepare('DELETE FROM command_idempotency WHERE tenant_id = ? AND key = ? AND completed_at IS NULL').bind(tenantId, key).run();
  throw error;
 }
 await db
  .prepare('UPDATE command_idempotency SET result_id = ?, completed_at = ? WHERE tenant_id = ? AND key = ?')
  .bind(resultId ?? null, Date.now(), tenantId, key)
  .run();
 // Limpeza das chaves antigas (a tela gera uma chave por operação): no máximo uma vez por hora.
 if (now - lastPurge > PURGE_EVERY_MS || now < lastPurge) {
  lastPurge = now;
  await db.prepare('DELETE FROM command_idempotency WHERE created_at < ? AND completed_at IS NOT NULL').bind(now - RETENTION_MS).run();
 }
 return { resultId, replayed: false };
}
