import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor, Sale } from '../domain.ts';
import { getStore, getProductForSale } from '../catalog/service.ts';
import { findOpenSessionForUser } from '../cash/service.ts';
import { buildSaleStockStatements, applySaleStockBatch } from '../inventory/service.ts';

// Venda relacional (instrucoes.md §11–13, §16–17). Fase 3: substitui `Sale`/`sale.create`/
// `sale.print` que viviam em `accounts.state` (JSON). Todas as vendas continuam gerando
// comprovante NÃO FISCAL (§12) — nenhum FiscalDocument é criado nesta fase.
//
// Status usado: só COMPLETED (criação) e CANCELLED (cancelamento) são alcançáveis hoje,
// porque a interface atual captura o pagamento no mesmo passo da criação (sem rascunho
// nem confirmação separada). DRAFT/PENDING_PAYMENT/PAID/REFUNDED (§17) ficam reservados
// para quando existir orçamento/pré-venda (§70) e devolução parcial (§54).

type PaymentLine = { method: string; amount: number };

export async function createSale(
 db: D1Database,
 tenantId: string,
 params: { storeId: string; items: { productId: string; qty: number }[]; customer: string; document: string; payment?: string; payments?: PaymentLine[] },
 actor: Actor,
 now = Date.now(),
): Promise<string> {
 requirePermission(actor.permissions, 'SALE_CREATE');
 const store = await getStore(db, tenantId, params.storeId);
 if (!store) throw new RuleError('Loja não encontrada.', 404);
 requireStoreAccess(actor, params.storeId);
 const session = await findOpenSessionForUser(db, tenantId, params.storeId, actor.userId);
 if (!session) throw new RuleError('Abra seu caixa nesta loja antes de vender.', 409);
 const ids = new Set(params.items.map((x) => x.productId));
 if (ids.size !== params.items.length) throw new RuleError('Produtos repetidos no carrinho.');

 const items: { productId: string; name: string; sku: string; qty: number; price: number }[] = [];
 const stockAdjustments: { storeId: string; productId: string; qty: number }[] = [];
 for (const item of params.items) {
  const product = await getProductForSale(db, tenantId, item.productId);
  if (!product) throw new RuleError('Produto não encontrado.', 404);
  items.push({ productId: product.id, name: product.name, sku: product.sku, qty: item.qty, price: product.price });
  stockAdjustments.push({ storeId: params.storeId, productId: product.id, qty: item.qty });
 }
 const total = items.reduce((a, i) => a + i.price * i.qty, 0);
 if (!Number.isSafeInteger(total) || total > 100000000) throw new RuleError('Valor da venda excede o limite.');

 const payments: PaymentLine[] = params.payment ? [{ method: params.payment, amount: total }] : (params.payments ?? []);
 const paymentsTotal = payments.reduce((a, p) => a + p.amount, 0);
 if (paymentsTotal !== total) throw new RuleError('A soma dos pagamentos não confere com o total da venda.');

 const id = crypto.randomUUID();
 const stockStatements = await buildSaleStockStatements(db, tenantId, stockAdjustments, actor.userId, id, {}, now);
 const insertStatements = [
  db
   .prepare('INSERT INTO sales (id, tenant_id, store_id, store_name, store_cnpj, cash_session_id, user_id, operator, customer, document, status, total, print_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)')
   .bind(id, tenantId, store.id, store.name, store.cnpj, session.id, actor.userId, actor.displayName, params.customer, params.document, 'COMPLETED', total, now),
  db.prepare('INSERT INTO non_fiscal_receipts (id, sale_id, created_at) VALUES (?,?,?)').bind(crypto.randomUUID(), id, now),
  ...items.map((item) => db.prepare('INSERT INTO sale_items (id, sale_id, product_id, name, sku, qty, price) VALUES (?,?,?,?,?,?,?)').bind(crypto.randomUUID(), id, item.productId, item.name, item.sku, item.qty, item.price)),
  ...payments.map((payment) => db.prepare('INSERT INTO sale_payments (id, sale_id, method, amount) VALUES (?,?,?,?)').bind(crypto.randomUUID(), id, payment.method, payment.amount)),
 ];
 // Fase 3: venda e estoque são ambos relacionais agora, então cabem numa única
 // transação SQL (db.batch()) — diferente da Fase 2, não é mais necessário compensar
 // uma escrita relacional bem-sucedida por causa de uma escrita em JSON que falhou depois.
 try {
  await db.batch([...stockStatements, ...insertStatements]);
 } catch {
  throw new RuleError('Estoque insuficiente para esta operação.', 409);
 }
 return id;
}

type SaleRow = { id: string; store_id: string; status: string; print_count: number };

async function loadSale(db: D1Database, tenantId: string, id: string): Promise<SaleRow> {
 const row = await db.prepare('SELECT id, store_id, status, print_count FROM sales WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<SaleRow>();
 if (!row) throw new RuleError('Venda não encontrada.', 404);
 return row;
}

export async function printSale(db: D1Database, tenantId: string, id: string, actor: Actor): Promise<void> {
 const sale = await loadSale(db, tenantId, id);
 requireStoreAccess(actor, sale.store_id);
 await db.prepare('UPDATE sales SET print_count = print_count + 1 WHERE id = ?').bind(id).run();
}

export async function cancelSale(db: D1Database, tenantId: string, id: string, actor: Actor, now = Date.now()): Promise<void> {
 requirePermission(actor.permissions, 'SALE_CANCEL');
 const sale = await loadSale(db, tenantId, id);
 requireStoreAccess(actor, sale.store_id);
 if (sale.status === 'CANCELLED') throw new RuleError('Venda já cancelada.', 409);
 // §29: uma NF-e autorizada não pode ficar órfã de uma venda cancelada por baixo dela.
 // Cancele a NF-e (fiscal.nfe.cancel) antes de cancelar a venda comercialmente.
 const fiscalDoc = await db.prepare("SELECT status FROM fiscal_documents WHERE sale_id = ? AND tenant_id = ?").bind(id, tenantId).first<{ status: string }>();
 if (fiscalDoc && fiscalDoc.status === 'AUTHORIZED') {
  throw new RuleError('Esta venda possui NF-e autorizada. Cancele a NF-e (fiscal) antes de cancelar a venda.', 409);
 }
 const items = await db.prepare('SELECT product_id AS productId, qty FROM sale_items WHERE sale_id = ?').bind(id).all<{ productId: string; qty: number }>();
 await applySaleStockBatch(db, tenantId, (items.results ?? []).map((i) => ({ storeId: sale.store_id, productId: i.productId, qty: i.qty })), actor.userId, id, { reverse: true }, now);
 await db.prepare("UPDATE sales SET status = 'CANCELLED' WHERE id = ?").bind(id).run();
}

export async function listSalesForSnapshot(db: D1Database, tenantId: string): Promise<Sale[]> {
  const rows = await db
   .prepare(
    'SELECT id, store_id AS storeId, store_name AS storeName, store_cnpj AS storeCnpj, cash_session_id AS cashId, user_id AS userId, operator, customer, document, status, print_count AS printCount, created_at AS createdAt FROM sales WHERE tenant_id = ? ORDER BY created_at DESC',
   )
   .bind(tenantId)
   .all<{ id: string; storeId: string; storeName: string; storeCnpj: string; cashId: string; userId: string; operator: string; customer: string; document: string; status: string; printCount: number; createdAt: number }>();
  const sales = rows.results ?? [];
  const result: Sale[] = [];
  for (const row of sales) {
   const items = await db.prepare('SELECT product_id AS productId, name, sku, qty, price FROM sale_items WHERE sale_id = ?').bind(row.id).all<{ productId: string; name: string; sku: string; qty: number; price: number }>();
   const payments = await db.prepare('SELECT method, amount FROM sale_payments WHERE sale_id = ?').bind(row.id).all<{ method: string; amount: number }>();
   const paymentRows = payments.results ?? [];
   const total = (items.results ?? []).reduce((a, i) => a + i.price * i.qty, 0);
   result.push({ ...row, items: items.results ?? [], total, payment: paymentRows.map((p) => p.method).join(' + '), fiscalStatus: 'pending' });
  }
  return result;
}
