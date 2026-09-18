import { RuleError } from './errors.ts';

// Idempotência (§31) para comandos relacionais (fora do JSON `state.requests`). Mesma
// garantia: mesma chave + mesmo comando -> mesmo resultado; mesma chave + comando
// diferente -> rejeitado.
type IdempotencyRow = { fingerprint: string; resultId: string | null };

export async function withIdempotency<T extends string | undefined>(
 db: D1Database,
 tenantId: string,
 key: string,
 fingerprint: string,
 run: () => Promise<T>,
): Promise<{ resultId: T | string | undefined; replayed: boolean }> {
 const existing = await db
  .prepare('SELECT fingerprint, result_id AS resultId FROM command_idempotency WHERE tenant_id = ? AND key = ?')
  .bind(tenantId, key)
  .first<IdempotencyRow>();
 if (existing) {
  if (existing.fingerprint !== fingerprint) throw new RuleError('Identificador de operação já utilizado.', 409);
  return { resultId: existing.resultId ?? undefined, replayed: true };
 }
 const resultId = await run();
 try {
  await db
   .prepare('INSERT INTO command_idempotency (tenant_id, key, fingerprint, result_id, created_at) VALUES (?,?,?,?,?)')
   .bind(tenantId, key, fingerprint, resultId ?? null, Date.now())
   .run();
 } catch {
  // Corrida rara: outra requisição com a mesma chave gravou primeiro. A operação já foi
  // executada (não há como desfazê-la de forma genérica aqui); deixamos o registro dela
  // vencer e devolvemos o resultado desta execução mesmo assim.
 }
 return { resultId, replayed: false };
}
