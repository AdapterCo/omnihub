import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor, Sale } from '../domain.ts';
import { getStore, getProductForSale, storeHasModality } from '../catalog/service.ts';
import { releaseOrderForCancelledSale } from '../orders/service.ts';
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
 // Pagamento integrado (lib/payments): a venda nasce PENDING_PAYMENT (§17) com o estoque já
 // reservado e só vira COMPLETED quando o provedor confirma o pagamento.
 options: { pendingPayment?: boolean; fromOrder?: { unitPrice: number } } = {},
): Promise<string> {
 requirePermission(actor.permissions, 'SALE_CREATE');
 const store = await getStore(db, tenantId, params.storeId);
 if (!store) throw new RuleError('Loja não encontrada.', 404);
 requireStoreAccess(actor, params.storeId);
 // Modalidades por loja: o PDV só vende se a loja tiver a modalidade PDV. Pedidos (venda com
 // contrato) finalizam por aqui também, mas não dependem da modalidade PDV.
 if (!options.fromOrder && !storeHasModality(store, 'PDV')) throw new RuleError(`A loja ${store.name} não tem a modalidade PDV (frente de caixa) habilitada.`, 409);
 if (options.fromOrder && (params.items.length !== 1 || params.items[0].qty !== 1)) throw new RuleError('Pedido gera venda de uma única unidade.', 400);
 if (params.discount && options.fromOrder) throw new RuleError('Desconto de pedido é negociado no valor do pedido.', 400);
 const session = await findOpenSessionForUser(db, tenantId, params.storeId, actor.userId);
 if (!session) throw new RuleError('Abra seu caixa nesta loja antes de vender.', 409);
 const ids = new Set(params.items.map((x) => x.productId));
 if (ids.size !== params.items.length) throw new RuleError('Produtos repetidos no carrinho.');

 const items: { productId: string; name: string; sku: string; qty: number; price: number }[] = [];
 const stockAdjustments: { storeId: string; productId: string; qty: number }[] = [];
 for (const item of params.items) {
  const product = await getProductForSale(db, tenantId, item.productId);
  if (!product) throw new RuleError('Produto não encontrado.', 404);
  // Moto/locação têm unidade física (chassi/IMEI): só saem por pedido, nunca pela quantidade avulsa do PDV.
  if (product.kind !== 'COMUM' && !options.fromOrder) throw new RuleError(`${product.name} é vendido por pedido (aba Pedidos), com o chassi/IMEI da unidade.`, 409);
  const price = options.fromOrder ? options.fromOrder.unitPrice : product.price;
  items.push({ productId: product.id, name: product.name, sku: product.sku, qty: item.qty, price });
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
   .bind(id, tenantId, store.id, store.name, store.cnpj, session.id, actor.userId, actor.displayName, params.customer, params.document, options.pendingPayment ? 'PENDING_PAYMENT' : 'COMPLETED', total, now, discount, discount ? (params.discount?.reason ?? '').trim() : '', discount ? actor.userId : null, authorizedBy?.userId ?? null, authorizedBy?.name ?? ''),
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

export async function cancelSale(db: D1Database, tenantId: string, id: string, actor: Actor, now = Date.now(), options: { providerRefunded?: boolean } = {}): Promise<void> {
 requirePermission(actor.permissions, 'SALE_CANCEL');
 const sale = await loadSale(db, tenantId, id);
 requireStoreAccess(actor, sale.store_id);
 if (sale.status === 'CANCELLED') throw new RuleError('Venda já cancelada.', 409);
 const orderBills=await db.prepare("SELECT r.id FROM order_receivables r JOIN orders o ON o.id=r.order_id WHERE o.sale_id=? AND r.tenant_id=? AND r.status NOT IN ('CANCELLED','REFUNDED') LIMIT 1").bind(id,tenantId).first();
 if(orderBills)throw new RuleError('Esta venda possui boletos de pedido. Concilie e cancele/estorne as cobranças no Asaas antes de cancelar a venda.',409);
 // Pagamento integrado: cobrança em aberto se resolve pelo fluxo de pagamento (cancelar a
 // cobrança devolve o estoque); cobrança paga só permite cancelar a venda depois do estorno
 // confirmado pelo provedor (lib/payments/service.ts faz o estorno e chama esta função).
 const charge = await db.prepare('SELECT status FROM payment_charges WHERE sale_id = ? AND tenant_id = ?').bind(id, tenantId).first<{ status: string }>();
 if (charge && ['CREATING', 'PENDING', 'ACTION_REQUIRED'].includes(charge.status)) {
  throw new RuleError('Esta venda tem uma cobrança integrada em andamento. Cancele a cobrança (o estoque volta automaticamente).', 409);
 }
 if (charge && charge.status === 'PAID' && !options.providerRefunded) {
  throw new RuleError('Esta venda foi paga por pagamento integrado. O cancelamento precisa estornar o pagamento no provedor primeiro.', 409);
 }
 if (sale.status === 'PENDING_PAYMENT') throw new RuleError('Venda aguardando pagamento: cancele a cobrança integrada.', 409);
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
 // Venda que veio de pedido: a unidade (chassi) volta a ficar disponível e o pedido fica cancelado.
 await releaseOrderForCancelledSale(db, tenantId, id, actor, now);
}

export type SaleListOptions = {
 /** Vendas criadas a partir deste instante, mais as que aguardam pagamento (janela do snapshot). */
 since?: number;
 /** Página de histórico: vendas criadas antes deste instante. */
 before?: number;
 limit?: number;
 /** Escopo de loja do usuário (nulo = todas). */
 storeId?: string | null;
};

// Sem opções: todas as vendas (uso em testes e rotinas internas). A tela recebe uma janela
// recente (app/api/workspace) e busca o restante por páginas, para o snapshot não crescer sem fim.
export async function listSalesForSnapshot(db: D1Database, tenantId: string, opts: SaleListOptions = {}): Promise<Sale[]> {
  const where = ['tenant_id = ?'];
  const binds: unknown[] = [tenantId];
  if (opts.storeId) { where.push('store_id = ?'); binds.push(opts.storeId); }
  if (opts.since !== undefined) { where.push("(created_at >= ? OR status = 'PENDING_PAYMENT')"); binds.push(opts.since); }
  if (opts.before !== undefined) { where.push('created_at < ?'); binds.push(opts.before); }
  const limit = opts.limit ? ` LIMIT ${Math.max(1, Math.min(2000, Math.floor(opts.limit)))}` : '';
  const rows = await db
   .prepare(
    `SELECT id, store_id AS storeId, store_name AS storeName, store_cnpj AS storeCnpj, cash_session_id AS cashId, user_id AS userId, operator, customer, document, status, total, discount, discount_reason AS discountReason, discount_authorized_by_name AS discountAuthorizedBy, returned_total AS returnedTotal, print_count AS printCount, created_at AS createdAt FROM sales WHERE ${where.join(' AND ')} ORDER BY created_at DESC${limit}`,
   )
   .bind(...binds)
   .all<{ id: string; storeId: string; storeName: string; storeCnpj: string; cashId: string; userId: string; operator: string; customer: string; document: string; status: string; total: number; discount: number; discountReason: string; discountAuthorizedBy: string; returnedTotal: number; printCount: number; createdAt: number }>();
  const sales = rows.results ?? [];
  if (sales.length === 0) return [];

  // Itens, pagamentos e devoluções só das vendas carregadas, em lotes (limite de parâmetros).
  const ids = sales.map((r) => r.id);
  const inBatches = async <T>(sql: (marks: string) => string): Promise<T[]> => {
   const out: T[] = [];
   for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const r = await db.prepare(sql(chunk.map(() => '?').join(','))).bind(tenantId, ...chunk).all<T>();
    out.push(...(r.results ?? []));
   }
   return out;
  };
  const itemRows = { results: await inBatches<{ id: string; saleId: string; productId: string; name: string; sku: string; qty: number; price: number; discount: number }>((m) => `SELECT si.id AS id, si.sale_id AS saleId, si.product_id AS productId, si.name AS name, si.sku AS sku, si.qty AS qty, si.price AS price, si.discount AS discount FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.tenant_id = ? AND si.sale_id IN (${m})`) };
  const paymentRows = { results: await inBatches<{ saleId: string; method: string }>((m) => `SELECT sp.sale_id AS saleId, sp.method AS method FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE s.tenant_id = ? AND sp.sale_id IN (${m})`) };
  const returnRows = { results: (await inBatches<{ id: string; saleId: string; operator: string; reason: string; refundMethod: string; total: number; createdAt: number }>((m) => `SELECT id, sale_id AS saleId, operator, reason, refund_method AS refundMethod, total, created_at AS createdAt FROM sale_returns WHERE tenant_id = ? AND sale_id IN (${m})`)).sort((a, b) => Number(a.createdAt) - Number(b.createdAt)) };
  const returnItemRows = { results: await inBatches<{ returnId: string; saleItemId: string; productId: string; name: string; qty: number; amount: number; restock: number }>((m) => `SELECT ri.return_id AS returnId, ri.sale_item_id AS saleItemId, ri.product_id AS productId, ri.name AS name, ri.qty AS qty, ri.amount AS amount, ri.restock AS restock FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id WHERE r.tenant_id = ? AND r.sale_id IN (${m})`) };

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
