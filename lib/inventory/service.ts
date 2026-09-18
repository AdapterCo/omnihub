import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { PermissionCode } from '../authz/permissions.ts';

// Ledger de estoque relacional (instrucoes.md §5–7). Fase 2: ainda NÃO é consumido pelo
// PDV (que continua operando sobre o JSON via lib/domain.ts) — ver nota em db/schema.ts.
export const STOCK_MOVEMENT_TYPES = [
 'INITIAL', 'PURCHASE', 'SALE', 'SALE_CANCEL', 'TRANSFER_OUT', 'TRANSFER_IN',
 'MANUAL_ADJUSTMENT', 'LOSS', 'DAMAGE', 'RETURN', 'INVENTORY_ADJUSTMENT',
] as const;
export type StockMovementType = typeof STOCK_MOVEMENT_TYPES[number];
export const TRANSFER_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'] as const;
export type TransferStatus = typeof TRANSFER_STATUSES[number];

type Actor = { userId: string; storeId?: string | null; role?: string; permissions: ReadonlySet<PermissionCode> };

function requireStockPermission(actor: Actor, code: PermissionCode) {
 requirePermission(actor.permissions, code);
}

/**
 * Ajusta o saldo de um produto em uma loja de forma atômica e segura contra concorrência
 * (§33): a instrução UPDATE aplica o delta e o CHECK `quantity >= 0` da tabela rejeita
 * (erro de constraint) qualquer resultado negativo, mesmo sob duas chamadas concorrentes
 * disputando o último item — não há janela de "ler saldo, decidir, gravar" comprometível.
 *
 * Limitação conhecida (documentada, não oculta): o registro em `stock_movements` é uma
 * segunda instrução, sequencial à primeira. Se o processo falhar exatamente entre as duas,
 * o saldo fica correto mas o movimento correspondente pode não ser registrado. Mitigação
 * futura possível: trigger SQL ou fila de reconciliação (não implementada nesta fase).
 */
export async function adjustStock(
 db: D1Database,
 params: { tenantId: string; storeId: string; productId: string; delta: number; type: StockMovementType; referenceType?: string; referenceId?: string; userId: string },
 actor: Actor,
 now = Date.now(),
): Promise<{ previousQuantity: number; newQuantity: number }> {
 requireStockPermission(actor, 'STOCK_ADJUST');
 requireStoreAccess(actor, params.storeId);
 const { tenantId, storeId, productId, delta, type, referenceType, referenceId, userId } = params;
 await db
  .prepare('INSERT INTO inventories (id, tenant_id, store_id, product_id, quantity) VALUES (?,?,?,?,0) ON CONFLICT(store_id, product_id) DO NOTHING')
  .bind(crypto.randomUUID(), tenantId, storeId, productId)
  .run();
 let updated: { quantity: number } | null;
 try {
  updated = await db
   .prepare('UPDATE inventories SET quantity = quantity + ? WHERE tenant_id = ? AND store_id = ? AND product_id = ? RETURNING quantity')
   .bind(delta, tenantId, storeId, productId)
   .first<{ quantity: number }>();
 } catch {
  throw new RuleError('Estoque insuficiente para esta operação.', 409);
 }
 if (!updated) throw new RuleError('Estoque não encontrado para esta loja/produto.', 404);
 const newQuantity = updated.quantity;
 const previousQuantity = newQuantity - delta;
 await db
  .prepare('INSERT INTO stock_movements (id, tenant_id, store_id, product_id, type, quantity, previous_quantity, new_quantity, reference_type, reference_id, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  .bind(crypto.randomUUID(), tenantId, storeId, productId, type, delta, previousQuantity, newQuantity, referenceType ?? null, referenceId ?? null, userId, now)
  .run();
 return { previousQuantity, newQuantity };
}

export async function receiveStock(
 db: D1Database,
 params: { tenantId: string; storeId: string; productId: string; quantity: number; userId: string; reason: string },
 actor: Actor,
 now = Date.now(),
) {
 requireStockPermission(actor, 'STOCK_ADJUST');
 if (params.quantity <= 0) throw new RuleError('Informe uma quantidade positiva.');
 return adjustStock(db, { tenantId: params.tenantId, storeId: params.storeId, productId: params.productId, delta: params.quantity, type: 'MANUAL_ADJUSTMENT', referenceType: 'manual_reason', referenceId: params.reason, userId: params.userId }, actor, now);
}

export async function getStock(db: D1Database, tenantId: string, storeId: string, productId: string): Promise<number> {
 const row = await db.prepare('SELECT quantity FROM inventories WHERE tenant_id = ? AND store_id = ? AND product_id = ?').bind(tenantId, storeId, productId).first<{ quantity: number }>();
 return row?.quantity ?? 0;
}

export async function listStockForStore(db: D1Database, tenantId: string, storeId: string): Promise<{ productId: string; quantity: number }[]> {
 const rows = await db.prepare('SELECT product_id AS productId, quantity FROM inventories WHERE tenant_id = ? AND store_id = ?').bind(tenantId, storeId).all<{ productId: string; quantity: number }>();
 return rows.results ?? [];
}

/** Forma compatível com o antigo `stock[storeId][productId]` embutido no JSON. */
export async function listStockMapForTenant(db: D1Database, tenantId: string): Promise<Record<string, Record<string, number>>> {
 const rows = await db.prepare('SELECT store_id AS storeId, product_id AS productId, quantity FROM inventories WHERE tenant_id = ?').bind(tenantId).all<{ storeId: string; productId: string; quantity: number }>();
 const map: Record<string, Record<string, number>> = {};
 for (const row of rows.results ?? []) {
  map[row.storeId] ??= {};
  map[row.storeId][row.productId] = row.quantity;
 }
 return map;
}

type TransferItemInput = { productId: string; quantity: number };
type TransferRow = { id: string; tenant_id: string; from_store_id: string; to_store_id: string; status: TransferStatus; requested_by: string; approved_by: string | null; received_by: string | null };

async function loadTransfer(db: D1Database, tenantId: string, id: string): Promise<TransferRow> {
 const row = await db.prepare('SELECT * FROM stock_transfers WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<TransferRow>();
 if (!row) throw new RuleError('Transferência não encontrada.', 404);
 return row;
}

async function loadTransferItems(db: D1Database, transferId: string): Promise<TransferItemInput[]> {
 const rows = await db.prepare('SELECT product_id AS productId, quantity FROM stock_transfer_items WHERE transfer_id = ?').bind(transferId).all<TransferItemInput>();
 return rows.results ?? [];
}

type SaleStockItem = { storeId: string; productId: string; qty: number };

/**
 * Monta (sem executar) as instruções que baixam/repõem estoque de uma venda: um UPDATE
 * guardado pelo CHECK `quantity >= 0` de `inventories` mais um INSERT em `stock_movements`
 * por item. Exposta separadamente para que lib/sales/service.ts possa incluir estas
 * instruções no MESMO `db.batch()` do INSERT da venda/itens/pagamentos (Fase 3: venda e
 * estoque são ambos relacionais agora, então cabem numa única transação SQL — ver
 * `createSale`). `applySaleStockBatch` abaixo continua existindo para quem precisa só do
 * efeito de estoque isoladamente (ex.: cancelamento de venda).
 */
export async function buildSaleStockStatements(db: D1Database, tenantId: string, items: SaleStockItem[], userId: string, referenceId: string, options: { reverse?: boolean } = {}, now = Date.now()) {
 if (items.length === 0) return [];
 const sign = options.reverse ? 1 : -1;
 const type: StockMovementType = options.reverse ? 'SALE_CANCEL' : 'SALE';
 for (const item of items) {
  await db.prepare('INSERT INTO inventories (id, tenant_id, store_id, product_id, quantity) VALUES (?,?,?,?,0) ON CONFLICT(store_id, product_id) DO NOTHING').bind(crypto.randomUUID(), tenantId, item.storeId, item.productId).run();
 }
 const previousQuantities = new Map<string, number>();
 for (const item of items) {
  const row = await db.prepare('SELECT quantity FROM inventories WHERE tenant_id = ? AND store_id = ? AND product_id = ?').bind(tenantId, item.storeId, item.productId).first<{ quantity: number }>();
  previousQuantities.set(`${item.storeId}:${item.productId}`, row?.quantity ?? 0);
 }
 const statements = [];
 for (const item of items) {
  const delta = sign * item.qty;
  const previous = previousQuantities.get(`${item.storeId}:${item.productId}`) ?? 0;
  statements.push(db.prepare('UPDATE inventories SET quantity = quantity + ? WHERE tenant_id = ? AND store_id = ? AND product_id = ?').bind(delta, tenantId, item.storeId, item.productId));
  statements.push(
   db
    .prepare('INSERT INTO stock_movements (id, tenant_id, store_id, product_id, type, quantity, previous_quantity, new_quantity, reference_type, reference_id, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), tenantId, item.storeId, item.productId, type, delta, previous, previous + delta, 'sale', referenceId, userId, now),
  );
 }
 return statements;
}

/** Baixa (ou repõe, se `reverse`) o estoque de uma venda isoladamente, em seu próprio `db.batch()`. */
export async function applySaleStockBatch(db: D1Database, tenantId: string, items: SaleStockItem[], userId: string, referenceId: string, options: { reverse?: boolean } = {}, now = Date.now()): Promise<void> {
 const statements = await buildSaleStockStatements(db, tenantId, items, userId, referenceId, options, now);
 if (statements.length === 0) return;
 try {
  await db.batch(statements);
 } catch {
  throw new RuleError('Estoque insuficiente para esta operação.', 409);
 }
}

/** Cria a solicitação de transferência (estado PENDING) com seus itens. Não movimenta estoque ainda (§7). */
export async function createTransfer(
 db: D1Database,
 params: { tenantId: string; fromStoreId: string; toStoreId: string; items: TransferItemInput[]; notes?: string },
 actor: Actor,
 now = Date.now(),
): Promise<string> {
 requireStockPermission(actor, 'STOCK_TRANSFER');
 requireStoreAccess(actor, params.fromStoreId);
 if (params.fromStoreId === params.toStoreId) throw new RuleError('Escolha lojas diferentes.');
 if (params.items.length === 0) throw new RuleError('Informe ao menos um item.');
 for (const item of params.items) if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new RuleError('Quantidade inválida no item de transferência.');
 const id = crypto.randomUUID();
 await db
  .prepare('INSERT INTO stock_transfers (id, tenant_id, from_store_id, to_store_id, status, requested_by, notes, created_at) VALUES (?,?,?,?,?,?,?,?)')
  .bind(id, params.tenantId, params.fromStoreId, params.toStoreId, 'PENDING' satisfies TransferStatus, actor.userId, params.notes ?? '', now)
  .run();
 for (const item of params.items) {
  await db.prepare('INSERT INTO stock_transfer_items (id, transfer_id, product_id, quantity) VALUES (?,?,?,?)').bind(crypto.randomUUID(), id, item.productId, item.quantity).run();
 }
 return id;
}

async function setTransferStatus(db: D1Database, id: string, expected: TransferStatus[], next: TransferStatus, extra: Record<string, string | number | null>) {
 const columns = Object.keys(extra);
 const placeholders = columns.map((c) => `${c} = ?`).join(', ');
 const sql = `UPDATE stock_transfers SET status = ?${placeholders ? ', ' + placeholders : ''} WHERE id = ? AND status IN (${expected.map(() => '?').join(',')})`;
 const result = await db.prepare(sql).bind(next, ...columns.map((c) => extra[c]), id, ...expected).run();
 if (result.meta.changes !== 1) throw new RuleError(`Transferência não está em um estado válido para esta ação (esperado: ${expected.join('/')}).`, 409);
}

/** PENDING -> APPROVED. Sem movimentação de estoque. */
export async function approveTransfer(db: D1Database, tenantId: string, id: string, actor: Actor, now = Date.now()) {
 requireStockPermission(actor, 'STOCK_TRANSFER');
 const transfer = await loadTransfer(db, tenantId, id);
 requireStoreAccess(actor, transfer.from_store_id);
 await setTransferStatus(db, id, ['PENDING'], 'APPROVED', { approved_by: actor.userId, approved_at: now });
}

/** APPROVED -> IN_TRANSIT. Decrementa o estoque da loja de origem, item a item, de forma atômica (TRANSFER_OUT). */
export async function dispatchTransfer(db: D1Database, tenantId: string, id: string, actor: Actor, now = Date.now()) {
 requireStockPermission(actor, 'STOCK_TRANSFER');
 const transfer = await loadTransfer(db, tenantId, id);
 requireStoreAccess(actor, transfer.from_store_id);
 const items = await loadTransferItems(db, id);
 for (const item of items) {
  await adjustStock(db, { tenantId, storeId: transfer.from_store_id, productId: item.productId, delta: -item.quantity, type: 'TRANSFER_OUT', referenceType: 'stock_transfer', referenceId: id, userId: actor.userId }, actor, now);
 }
 await setTransferStatus(db, id, ['APPROVED'], 'IN_TRANSIT', { dispatched_at: now });
}

/** IN_TRANSIT -> RECEIVED. Incrementa o estoque da loja de destino, item a item (TRANSFER_IN). */
export async function receiveTransfer(db: D1Database, tenantId: string, id: string, actor: Actor, now = Date.now()) {
 requireStockPermission(actor, 'STOCK_TRANSFER');
 const transfer = await loadTransfer(db, tenantId, id);
 requireStoreAccess(actor, transfer.to_store_id);
 const items = await loadTransferItems(db, id);
 for (const item of items) {
  await adjustStock(db, { tenantId, storeId: transfer.to_store_id, productId: item.productId, delta: item.quantity, type: 'TRANSFER_IN', referenceType: 'stock_transfer', referenceId: id, userId: actor.userId }, actor, now);
 }
 await setTransferStatus(db, id, ['IN_TRANSIT'], 'RECEIVED', { received_by: actor.userId, received_at: now });
}

/** Cancela antes do despacho (PENDING/APPROVED). Depois de IN_TRANSIT, não é mais cancelável — o estoque já saiu da origem. */
export async function cancelTransfer(db: D1Database, tenantId: string, id: string, actor: Actor, now = Date.now()) {
 requireStockPermission(actor, 'STOCK_TRANSFER');
 const transfer = await loadTransfer(db, tenantId, id);
 requireStoreAccess(actor, transfer.from_store_id);
 await setTransferStatus(db, id, ['PENDING', 'APPROVED'], 'CANCELLED', { cancelled_at: now });
}

// Forma compatível com o antigo `Transfer` embutido no JSON. Exibe em trânsito, recebidas e canceladas.
export type TransferSnapshotRow = { id: string; from: string; to: string; productId: string; productName: string; qty: number; status: 'transit' | 'received' | 'cancelled'; createdAt: number; receivedAt?: number; cancelledAt?: number; operator: string };

export async function listTransfersForSnapshot(db: D1Database, tenantId: string): Promise<TransferSnapshotRow[]> {
 const rows = await db
  .prepare(
   `SELECT t.id AS id, t.from_store_id AS from_, t.to_store_id AS to_, t.status AS status, t.created_at AS createdAt, t.received_at AS receivedAt, t.cancelled_at AS cancelledAt,
     t.requested_by AS requestedBy, i.product_id AS productId, i.quantity AS qty, p.name AS productName, u.display_name AS operator
    FROM stock_transfers t
    JOIN stock_transfer_items i ON i.transfer_id = t.id
    JOIN products p ON p.id = i.product_id
    LEFT JOIN users u ON u.id = t.requested_by
    WHERE t.tenant_id = ? AND t.status IN ('IN_TRANSIT','RECEIVED','CANCELLED')
    ORDER BY t.created_at DESC`,
  )
  .bind(tenantId)
  .all<{ id: string; from_: string; to_: string; status: TransferStatus; createdAt: number; receivedAt: number | null; cancelledAt: number | null; requestedBy: string; productId: string; qty: number; productName: string; operator: string | null }>();
 return (rows.results ?? []).map((row) => ({
  id: row.id,
  from: row.from_,
  to: row.to_,
  productId: row.productId,
  productName: row.productName,
  qty: row.qty,
  status: row.status === 'RECEIVED' ? 'received' : row.status === 'CANCELLED' ? 'cancelled' : 'transit',
  createdAt: row.createdAt,
  receivedAt: row.receivedAt ?? undefined,
  cancelledAt: row.cancelledAt ?? undefined,
  operator: row.operator ?? row.requestedBy,
 }));
}
