import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor, Sale } from '../domain.ts';
import { getStore, getProductForSale } from '../catalog/service.ts';
import { findOpenSessionForUser } from '../cash/service.ts';
import { buildSaleStockStatements, applySaleStockBatch } from '../inventory/service.ts';
import { allocateDiscount, computeDiscountCents, resolveDiscountAuthority, type DiscountRequest, type SupervisorAuthorization } from './discount.ts';

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
 params: { storeId: string; items: { productId: string; qty: number }[]; customer: string; document: string; payment?: string; payments?: PaymentLine[]; discount?: DiscountRequest; authorization?: SupervisorAuthorization },
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
 const gross = items.reduce((a, i) => a + i.price * i.qty, 0);
 if (!Number.isSafeInteger(gross) || gross > 100000000) throw new RuleError('Valor da venda excede o limite.');

 // §53: desconto sobre o total da venda. `total` (gravado em sales.total) é o valor LÍQUIDO,
 // o que o cliente paga; o desconto fica separado e é rateado por item para o documento fiscal.
 let discount = 0;
 let authorizedBy: { userId: string; name: string } | null = null;
 if (params.discount) {
  discount = computeDiscountCents(gross, params.discount);
  authorizedBy = (await resolveDiscountAuthority(db, tenantId, actor, discount, gross, params.authorization, now)).authorizedBy;
 } else if (params.authorization) {
  throw new RuleError('Autorização de supervisor informada sem desconto na venda.', 400);
 }
 const itemDiscounts = allocateDiscount(items, discount);
 const total = gross - discount;

 const payments: PaymentLine[] = params.payment ? [{ method: params.payment, amount: total }] : (params.payments ?? []);
 const paymentsTotal = payments.reduce((a, p) => a + p.amount, 0);
 if (paymentsTotal !== total) throw new RuleError('A soma dos pagamentos não confere com o total da venda.');

 const id = crypto.randomUUID();
 const stockStatements = await buildSaleStockStatements(db, tenantId, stockAdjustments, actor.userId, id, {}, now);
 const insertStatements = [
  db
   .prepare('INSERT INTO sales (id, tenant_id, store_id, store_name, store_cnpj, cash_session_id, user_id, operator, customer, document, status, total, print_count, created_at, discount, discount_reason, discount_granted_by, discount_authorized_by, discount_authorized_by_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)')
   .bind(id, tenantId, store.id, store.name, store.cnpj, session.id, actor.userId, actor.displayName, params.customer, params.document, 'COMPLETED', total, now, discount, discount ? (params.discount?.reason ?? '').trim() : '', discount ? actor.userId : null, authorizedBy?.userId ?? null, authorizedBy?.name ?? ''),
  db.prepare('INSERT INTO non_fiscal_receipts (id, sale_id, created_at) VALUES (?,?,?)').bind(crypto.randomUUID(), id, now),
  ...items.map((item, index) => db.prepare('INSERT INTO sale_items (id, sale_id, product_id, name, sku, qty, price, discount) VALUES (?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(), id, item.productId, item.name, item.sku, item.qty, item.price, itemDiscounts[index])),
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

type SaleRow = { id: string; store_id: string; status: string; print_count: number; returned_total: number };

async function loadSale(db: D1Database, tenantId: string, id: string): Promise<SaleRow> {
 const row = await db.prepare('SELECT id, store_id, status, print_count, returned_total FROM sales WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<SaleRow>();
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
 // §54: cancelamento (venda inteira, antes de qualquer devolução) e devolução são fluxos
 // diferentes. Cancelar uma venda que já teve itens devolvidos devolveria o estoque duas
 // vezes e estornaria o dinheiro duas vezes.
 if (sale.status === 'REFUNDED' || Number(sale.returned_total) > 0) {
  throw new RuleError('Esta venda já possui devolução registrada e não pode mais ser cancelada. Registre a devolução dos itens restantes.', 409);
 }
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
    'SELECT id, store_id AS storeId, store_name AS storeName, store_cnpj AS storeCnpj, cash_session_id AS cashId, user_id AS userId, operator, customer, document, status, total, discount, discount_reason AS discountReason, discount_authorized_by_name AS discountAuthorizedBy, returned_total AS returnedTotal, print_count AS printCount, created_at AS createdAt FROM sales WHERE tenant_id = ? ORDER BY created_at DESC',
   )
   .bind(tenantId)
   .all<{ id: string; storeId: string; storeName: string; storeCnpj: string; cashId: string; userId: string; operator: string; customer: string; document: string; status: string; total: number; discount: number; discountReason: string; discountAuthorizedBy: string; returnedTotal: number; printCount: number; createdAt: number }>();
  const sales = rows.results ?? [];
  if (sales.length === 0) return [];

  // Três consultas em lote (itens, pagamentos, devoluções) em vez de duas por venda.
  const itemRows = await db
   .prepare('SELECT si.id AS id, si.sale_id AS saleId, si.product_id AS productId, si.name AS name, si.sku AS sku, si.qty AS qty, si.price AS price, si.discount AS discount FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.tenant_id = ?')
   .bind(tenantId)
   .all<{ id: string; saleId: string; productId: string; name: string; sku: string; qty: number; price: number; discount: number }>();
  const paymentRows = await db
   .prepare('SELECT sp.sale_id AS saleId, sp.method AS method FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE s.tenant_id = ?')
   .bind(tenantId)
   .all<{ saleId: string; method: string }>();
  const returnRows = await db
   .prepare('SELECT id, sale_id AS saleId, operator, reason, refund_method AS refundMethod, total, created_at AS createdAt FROM sale_returns WHERE tenant_id = ? ORDER BY created_at')
   .bind(tenantId)
   .all<{ id: string; saleId: string; operator: string; reason: string; refundMethod: string; total: number; createdAt: number }>();
  const returnItemRows = await db
   .prepare('SELECT ri.return_id AS returnId, ri.sale_item_id AS saleItemId, ri.product_id AS productId, ri.name AS name, ri.qty AS qty, ri.amount AS amount, ri.restock AS restock FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id WHERE r.tenant_id = ?')
   .bind(tenantId)
   .all<{ returnId: string; saleItemId: string; productId: string; name: string; qty: number; amount: number; restock: number }>();

  const group = <T extends Record<string, unknown>>(list: T[], key: keyof T) => {
   const map = new Map<unknown, T[]>();
   for (const entry of list) map.set(entry[key], [...(map.get(entry[key]) ?? []), entry]);
   return map;
  };
  const itemsBySale = group(itemRows.results ?? [], 'saleId');
  const paymentsBySale = group(paymentRows.results ?? [], 'saleId');
  const returnsBySale = group(returnRows.results ?? [], 'saleId');
  const returnItemsByReturn = group(returnItemRows.results ?? [], 'returnId');
  const returnedQtyByItem = new Map<string, number>();
  for (const ri of returnItemRows.results ?? []) returnedQtyByItem.set(ri.saleItemId, (returnedQtyByItem.get(ri.saleItemId) ?? 0) + Number(ri.qty));

  return sales.map((row) => ({
   ...row,
   items: (itemsBySale.get(row.id) ?? []).map((i) => ({ productId: i.productId, name: i.name, sku: i.sku, qty: i.qty, price: i.price, discount: Number(i.discount), returnedQty: returnedQtyByItem.get(i.id) ?? 0 })),
   payment: (paymentsBySale.get(row.id) ?? []).map((p) => p.method).join(' + '),
   fiscalStatus: 'pending' as const,
   returns: (returnsBySale.get(row.id) ?? []).map((r) => ({
    id: r.id, createdAt: r.createdAt, operator: r.operator, reason: r.reason, refundMethod: r.refundMethod, total: Number(r.total),
    items: (returnItemsByReturn.get(r.id) ?? []).map((ri) => ({ productId: ri.productId, name: ri.name, qty: Number(ri.qty), amount: Number(ri.amount), restock: Number(ri.restock) === 1 })),
   })),
  }));
}
