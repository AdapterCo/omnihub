import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor, Cash } from '../domain.ts';
import { getStore } from '../catalog/service.ts';

// Caixa relacional (instrucoes.md §14–15). Fase 3: substitui o `Cash`/`cash.open`/
// `cash.close` que viviam em `accounts.state` (JSON). Sangria/suprimento (§15) são
// funcionalidade nova — não existiam no modelo anterior.

/** Garante um terminal (cash_register) por loja. Não expõe nenhuma tela nova: o próprio "abrir caixa" cria o terminal padrão na primeira vez. */
async function getOrCreateRegister(db: D1Database, tenantId: string, storeId: string, now: number): Promise<string> {
 const existing = await db.prepare('SELECT id FROM cash_registers WHERE tenant_id = ? AND store_id = ? ORDER BY created_at LIMIT 1').bind(tenantId, storeId).first<{ id: string }>();
 if (existing) return existing.id;
 const id = crypto.randomUUID();
 await db.prepare('INSERT INTO cash_registers (id, tenant_id, store_id, name, created_at) VALUES (?,?,?,?,?)').bind(id, tenantId, storeId, 'Caixa 1', now).run();
 return id;
}

export async function openSession(db: D1Database, tenantId: string, storeId: string, opening: number, actor: Actor, now = Date.now()): Promise<string> {
 requirePermission(actor.permissions, 'CASH_OPEN');
 const store = await getStore(db, tenantId, storeId);
 if (!store) throw new RuleError('Loja não encontrada.', 404);
 requireStoreAccess(actor, storeId);
 const open = await db.prepare('SELECT id FROM cash_sessions WHERE tenant_id = ? AND store_id = ? AND user_id = ? AND closed_at IS NULL').bind(tenantId, storeId, actor.userId).first<{ id: string }>();
 if (open) throw new RuleError('Você já tem um caixa aberto nesta loja.', 409);
 const registerId = await getOrCreateRegister(db, tenantId, storeId, now);
 const id = crypto.randomUUID();
 await db
  .prepare('INSERT INTO cash_sessions (id, tenant_id, cash_register_id, store_id, user_id, operator, opened_at, opening_amount) VALUES (?,?,?,?,?,?,?,?)')
  .bind(id, tenantId, registerId, storeId, actor.userId, actor.displayName, now, opening)
  .run();
 return id;
}

type SessionRow = { id: string; tenant_id: string; store_id: string; user_id: string; opening_amount: number; closed_at: number | null };

async function loadSession(db: D1Database, tenantId: string, id: string): Promise<SessionRow> {
 const row = await db.prepare('SELECT * FROM cash_sessions WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<SessionRow>();
 if (!row) throw new RuleError('Caixa não encontrado.', 404);
 return row;
}

/** Soma pagamentos em dinheiro das vendas não canceladas da sessão, mais suprimentos, menos sangrias (§14). */
async function computeExpected(db: D1Database, tenantId: string, session: SessionRow): Promise<number> {
 const cashSales = await db
  .prepare(
   `SELECT COALESCE(SUM(sp.amount),0) AS total FROM sale_payments sp
    JOIN sales s ON s.id = sp.sale_id
    WHERE s.tenant_id = ? AND s.cash_session_id = ? AND s.status != 'CANCELLED' AND sp.method = 'Dinheiro'`,
  )
  .bind(tenantId, session.id)
  .first<{ total: number }>();
 const supply = await db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM cash_movements WHERE cash_session_id = ? AND type = 'SUPPLY'").bind(session.id).first<{ total: number }>();
 const withdrawal = await db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM cash_movements WHERE cash_session_id = ? AND type = 'WITHDRAWAL'").bind(session.id).first<{ total: number }>();
 // §54: devolução estornada em dinheiro sai do caixa (movimento REFUND) e reduz o esperado.
 const refunds = await db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM cash_movements WHERE cash_session_id = ? AND type = 'REFUND'").bind(session.id).first<{ total: number }>();
 return session.opening_amount + (cashSales?.total ?? 0) + (supply?.total ?? 0) - (withdrawal?.total ?? 0) - (refunds?.total ?? 0);
}

export async function closeSession(db: D1Database, tenantId: string, id: string, counted: number, actor: Actor, now = Date.now()): Promise<void> {
 const session = await loadSession(db, tenantId, id);
 requireStoreAccess(actor, session.store_id);
 if (actor.role !== 'admin' && session.user_id !== actor.userId) throw new RuleError('Você só pode fechar seu próprio caixa.', 403);
 if (session.closed_at) throw new RuleError('Caixa já fechado.', 409);
 const expected = await computeExpected(db, tenantId, session);
 await db.prepare('UPDATE cash_sessions SET closed_at = ?, counted_amount = ?, expected_amount = ?, difference = ? WHERE id = ?').bind(now, counted, expected, counted - expected, id).run();
}

export async function recordMovement(db: D1Database, tenantId: string, id: string, type: 'SUPPLY' | 'WITHDRAWAL', amount: number, reason: string, actor: Actor, now = Date.now()): Promise<void> {
 requirePermission(actor.permissions, type === 'SUPPLY' ? 'CASH_SUPPLY' : 'CASH_WITHDRAWAL');
 const session = await loadSession(db, tenantId, id);
 requireStoreAccess(actor, session.store_id);
 if (session.closed_at) throw new RuleError('Caixa já fechado.', 409);
 await db.prepare('INSERT INTO cash_movements (id, tenant_id, cash_session_id, type, amount, reason, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(), tenantId, id, type, amount, reason, actor.userId, now).run();
}

/** Sessão aberta do próprio usuário nesta loja (usada por lib/sales para exigir caixa aberto antes de vender). */
export async function findOpenSessionForUser(db: D1Database, tenantId: string, storeId: string, userId: string): Promise<{ id: string } | null> {
 return db.prepare('SELECT id FROM cash_sessions WHERE tenant_id = ? AND store_id = ? AND user_id = ? AND closed_at IS NULL').bind(tenantId, storeId, userId).first<{ id: string }>();
}

export async function listSessionsForSnapshot(db: D1Database, tenantId: string): Promise<Cash[]> {
 const rows = await db
  .prepare('SELECT id, store_id AS storeId, user_id AS userId, operator, opened_at AS openedAt, opening_amount AS opening, closed_at AS closedAt, counted_amount AS counted, expected_amount AS expected, difference FROM cash_sessions WHERE tenant_id = ? ORDER BY opened_at DESC')
  .bind(tenantId)
  .all<{ id: string; storeId: string; userId: string; operator: string; openedAt: number; opening: number; closedAt: number | null; counted: number | null; expected: number | null; difference: number | null }>();
 return (rows.results ?? []).map((r) => ({ id: r.id, storeId: r.storeId, userId: r.userId, operator: r.operator, openedAt: r.openedAt, opening: r.opening, closedAt: r.closedAt ?? undefined, counted: r.counted ?? undefined, expected: r.expected ?? undefined, difference: r.difference ?? undefined }));
}
