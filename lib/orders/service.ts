import { RuleError } from '../errors.ts';
import { SALE_CHANNELS } from '../fiscal/operation.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor, ProductKind, StoreModality } from '../domain.ts';
import { getStore, storeHasModality } from '../catalog/service.ts';
import { findOpenSessionForUser } from '../cash/service.ts';
import { createSale } from '../sales/service.ts';
import { dayKey } from '../time.ts';
import { assertOrderContractsEditable, invalidateOrderContracts } from '../contracts/service.ts';

// Pedidos de venda com contrato (moto) e de locação (celular/equipamento), com unidade física
// identificada (chassi/série ou IMEI). Fluxo pedido do usuário: o vendedor (inclusive o
// Vendedor online) cadastra o cliente, monta o pedido — o que já RESERVA a unidade —, envia o
// contrato e depois recebe/entrega/finaliza na loja. Finalizar uma VENDA gera a venda comum
// (sales), com caixa, estoque e fiscal existentes; finalizar uma LOCAÇÃO entrega o equipamento
// (unidade RENTED, estoque sai com movimento RENTAL_OUT). Pedido nunca é apagado: cancelado
// fica registrado com motivo, e a unidade volta a ficar disponível.

export const ORDER_TYPES = ['VENDA', 'LOCACAO'] as const;
export type OrderType = typeof ORDER_TYPES[number];
// Formas de recebimento na loja: as mesmas do PDV. Boleto é gerado pelo Asaas (fase de cobrança).
export const STORE_PAYMENT_METHODS = ['Dinheiro', 'Pix', 'Cartão de crédito', 'Cartão de débito'] as const;
export type StorePaymentMethod = typeof STORE_PAYMENT_METHODS[number];

// Modelo de contrato de locação v1 (ContratoLocacao.pdf): 12 mensalidades. O número vem do
// texto do contrato, não é escolha do sistema; se um contrato futuro mudar, muda a versão.
export const RENTAL_MONTHS_V1 = 12;

const TYPE_MODALITY: Record<OrderType, StoreModality> = { VENDA: 'VENDA_CONTRATO', LOCACAO: 'LOCACAO' };
const TYPE_KIND: Record<OrderType, ProductKind> = { VENDA: 'MOTO', LOCACAO: 'LOCACAO' };
const KIND_MODALITY: Record<Exclude<ProductKind, 'COMUM'>, StoreModality> = { MOTO: 'VENDA_CONTRATO', LOCACAO: 'LOCACAO' };
const TYPE_LABEL: Record<OrderType, string> = { VENDA: 'venda com contrato (moto)', LOCACAO: 'locação' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value: string): boolean {
 if (!DATE_RE.test(value)) return false;
 const [y, m, d] = value.split('-').map(Number);
 const date = new Date(Date.UTC(y, m - 1, d));
 return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// ===================== Unidades (chassi/IMEI) =====================

export type UnitInput = { storeId: string; productId: string; serial: string; color?: string; memory?: string; condition?: string };

export type UnitRecord = { id: string; storeId: string; productId: string; productName: string; kind: ProductKind; serial: string; color: string; memory: string; condition: string; status: string; orderId: string | null; createdAt: number };

function normalizeSerial(kind: ProductKind, raw: string): string {
 const serial = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
 if (kind === 'LOCACAO') {
  // IMEI: 15 dígitos (padrão GSMA). Só formato; nada é presumido sobre o aparelho.
  if (!/^\d{15}$/.test(serial)) throw new RuleError('Informe o IMEI com 15 dígitos.', 400);
  return serial;
 }
 if (serial.length < 3 || serial.length > 40 || !/^[A-Z0-9./-]+$/.test(serial)) throw new RuleError('Informe o chassi/série (3 a 40 caracteres, letras e números).', 400);
 return serial;
}

export async function registerUnit(db: D1Database, tenantId: string, input: UnitInput, actor: Actor, now = Date.now()): Promise<string> {
 requirePermission(actor.permissions, 'STOCK_ADJUST');
 const store = await getStore(db, tenantId, input.storeId);
 if (!store) throw new RuleError('Loja não encontrada.', 404);
 requireStoreAccess(actor, store.id);
 const product = await db.prepare('SELECT id, name, kind FROM products WHERE id = ? AND tenant_id = ?').bind(input.productId, tenantId).first<{ id: string; name: string; kind: ProductKind }>();
 if (!product) throw new RuleError('Produto não encontrado.', 404);
 if (product.kind === 'COMUM') throw new RuleError('Este produto é comum (PDV). Unidades com chassi/IMEI só existem para produtos do tipo Moto ou Locação.', 400);
 const modality = KIND_MODALITY[product.kind];
 if (!storeHasModality(store, modality)) throw new RuleError(`A loja ${store.name} não tem a modalidade ${modality === 'LOCACAO' ? 'Locação' : 'Venda com contrato'} habilitada.`, 409);
 const serial = normalizeSerial(product.kind, input.serial);
 const color = String(input.color ?? '').trim();
 const memory = String(input.memory ?? '').trim();
 const condition = String(input.condition ?? '').trim();
 // Campos exigidos pelos contratos (instrucao-sistema-vendas.md §7): moto precisa de cor;
 // locação precisa de cor, memória e estado do aparelho.
 const missing: string[] = [];
 if (!color) missing.push('cor');
 if (product.kind === 'LOCACAO' && !memory) missing.push('memória');
 if (product.kind === 'LOCACAO' && !condition) missing.push('estado do aparelho');
 if (missing.length) throw new RuleError(`Preencha: ${missing.join(', ')}.`, 400);
 if ([color, memory, condition].some((v) => v.length > 80)) throw new RuleError('Cor, memória e estado têm no máximo 80 caracteres.', 400);
 const dupe = await db.prepare('SELECT id FROM product_units WHERE tenant_id = ? AND serial = ?').bind(tenantId, serial).first<{ id: string }>();
 if (dupe) throw new RuleError(product.kind === 'LOCACAO' ? 'Este IMEI já está cadastrado.' : 'Este chassi/série já está cadastrado.', 409);

 const id = crypto.randomUUID();
 const stockRow = await db.prepare('SELECT quantity FROM inventories WHERE tenant_id = ? AND store_id = ? AND product_id = ?').bind(tenantId, store.id, product.id).first<{ quantity: number }>();
 const previous = Number(stockRow?.quantity ?? 0);
 await db.batch([
  db.prepare('INSERT INTO product_units (id, tenant_id, store_id, product_id, serial, color, memory, condition, status, order_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?)')
   .bind(id, tenantId, store.id, product.id, serial, color, memory, condition, 'AVAILABLE', actor.userId, now, now),
  db.prepare('INSERT INTO inventories (id, tenant_id, store_id, product_id, quantity) VALUES (?,?,?,?,0) ON CONFLICT(store_id, product_id) DO NOTHING').bind(crypto.randomUUID(), tenantId, store.id, product.id),
  db.prepare('UPDATE inventories SET quantity = quantity + 1 WHERE tenant_id = ? AND store_id = ? AND product_id = ?').bind(tenantId, store.id, product.id),
  db.prepare('INSERT INTO stock_movements (id, tenant_id, store_id, product_id, type, quantity, previous_quantity, new_quantity, reference_type, reference_id, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
   .bind(crypto.randomUUID(), tenantId, store.id, product.id, 'MANUAL_ADJUSTMENT', 1, previous, previous + 1, 'UNIT', id, actor.userId, now),
 ]);
 return id;
}

/** Tira do estoque uma unidade disponível cadastrada por engano. Não apaga: fica REMOVED. */
export async function removeUnit(db: D1Database, tenantId: string, unitId: string, actor: Actor, now = Date.now()): Promise<void> {
 requirePermission(actor.permissions, 'STOCK_ADJUST');
 const unit = await db.prepare('SELECT id, store_id AS storeId, product_id AS productId, status FROM product_units WHERE id = ? AND tenant_id = ?').bind(unitId, tenantId).first<{ id: string; storeId: string; productId: string; status: string }>();
 if (!unit) throw new RuleError('Unidade não encontrada.', 404);
 requireStoreAccess(actor, unit.storeId);
 const claimed = await db.prepare("UPDATE product_units SET status = 'REMOVED', updated_at = ? WHERE id = ? AND status = 'AVAILABLE'").bind(now, unitId).run();
 if (claimed.meta.changes !== 1) throw new RuleError('Só é possível remover uma unidade disponível (sem pedido).', 409);
 const stockRow = await db.prepare('SELECT quantity FROM inventories WHERE tenant_id = ? AND store_id = ? AND product_id = ?').bind(tenantId, unit.storeId, unit.productId).first<{ quantity: number }>();
 const previous = Number(stockRow?.quantity ?? 0);
 try {
  await db.batch([
   db.prepare('UPDATE inventories SET quantity = quantity - 1 WHERE tenant_id = ? AND store_id = ? AND product_id = ?').bind(tenantId, unit.storeId, unit.productId),
   db.prepare('INSERT INTO stock_movements (id, tenant_id, store_id, product_id, type, quantity, previous_quantity, new_quantity, reference_type, reference_id, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), tenantId, unit.storeId, unit.productId, 'MANUAL_ADJUSTMENT', -1, previous, previous - 1, 'UNIT', unitId, actor.userId, now),
  ]);
 } catch {
  await db.prepare("UPDATE product_units SET status = 'AVAILABLE', updated_at = ? WHERE id = ?").bind(now, unitId).run();
  throw new RuleError('O estoque desta unidade já foi baixado; não foi possível removê-la.', 409);
 }
}

export async function listUnits(db: D1Database, tenantId: string): Promise<UnitRecord[]> {
 const rows = await db
  .prepare(
   `SELECT u.id AS id, u.store_id AS storeId, u.product_id AS productId, p.name AS productName, p.kind AS kind, u.serial AS serial, u.color AS color,
           u.memory AS memory, u.condition AS condition, u.status AS status, u.order_id AS orderId, u.created_at AS createdAt
    FROM product_units u JOIN products p ON p.id = u.product_id
    WHERE u.tenant_id = ? AND u.status <> 'REMOVED' ORDER BY u.created_at DESC`,
  )
  .bind(tenantId)
  .all<UnitRecord>();
 return (rows.results ?? []).map((u) => ({ ...u, createdAt: Number(u.createdAt) }));
}

// ===================== Pedidos =====================

export type OrderInput = {
 storeId: string;
 type: OrderType;
 customerId: string;
 unitId: string;
 // Venda (moto)
 total?: number;
 purchaseDate?: string;
 downPayment?: number;
 downPaymentMethod?: string;
 installments?: number;
 firstDueDate?: string;
 // Como o cliente comprou (venda): vai para o indPres da nota fiscal.
 saleChannel?: string;
 // Locação
 adhesionAmount?: number;
 adhesionBilling?: 'BOLETO' | 'LOJA';
 adhesionPaymentMethod?: string;
 monthlyAmount?: number;
 dueDay?: number;
};

type OrderTerms = {
 total: number; purchase_date: string; down_payment: number; down_payment_method: string; installments: number; first_due_date: string; sale_channel: string;
 adhesion_amount: number; adhesion_billing: string; adhesion_payment_method: string; monthly_amount: number; due_day: number;
};

// Limite técnico de parcelas: evita digitação absurda. A regra comercial (quantas parcelas o
// cliente pode ter) é do vendedor, pedido do usuário; o limite do provedor de boleto é conferido
// na fase de cobrança.
const MAX_INSTALLMENTS = 60;

function validateTerms(type: OrderType, input: OrderInput, now: number): OrderTerms {
 const cents = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : NaN);
 if (type === 'VENDA') {
  const total = cents(input.total);
  if (!(total > 0) || total > 100000000) throw new RuleError('Informe o valor da venda.', 400);
  const purchaseDate = String(input.purchaseDate || dayKey(now));
  if (!validDate(purchaseDate)) throw new RuleError('Data da compra inválida.', 400);
  const installments = input.installments ?? 0;
  if (!Number.isInteger(installments) || installments < 0 || installments > MAX_INSTALLMENTS) throw new RuleError(`Número de parcelas no boleto inválido (0 a ${MAX_INSTALLMENTS}).`, 400);
  const downPayment = cents(input.downPayment ?? 0);
  if (!(downPayment >= 0) || downPayment > total) throw new RuleError('Valor de entrada inválido.', 400);
  const method = String(input.downPaymentMethod ?? '').trim();
  let firstDueDate = '';
  if (installments === 0) {
   // Sem boleto: tudo é recebido na loja.
   if (downPayment !== total) throw new RuleError('Sem parcelas no boleto, o valor recebido na loja deve ser o valor total da venda.', 400);
  } else {
   if (downPayment === total) throw new RuleError('Com parcelas no boleto, a entrada deve ser menor que o valor total.', 400);
   firstDueDate = String(input.firstDueDate ?? '');
   if (!validDate(firstDueDate)) throw new RuleError('Informe a data do primeiro vencimento do boleto.', 400);
   if (firstDueDate < dayKey(now)) throw new RuleError('O primeiro vencimento do boleto não pode estar no passado.', 400);
  }
  const saleChannel = String(input.saleChannel ?? '');
  if (!(SALE_CHANNELS as readonly string[]).includes(saleChannel)) throw new RuleError('Informe como o cliente comprou: na loja, pela internet/WhatsApp ou entrega em domicílio (vai para a nota fiscal).', 400);
  if (downPayment > 0 && !(STORE_PAYMENT_METHODS as readonly string[]).includes(method)) throw new RuleError('Informe a forma de pagamento recebida na loja (Dinheiro, Pix, Cartão de crédito ou Cartão de débito).', 400);
  return { total, purchase_date: purchaseDate, down_payment: downPayment, down_payment_method: downPayment > 0 ? method : '', installments, first_due_date: firstDueDate, sale_channel: saleChannel, adhesion_amount: 0, adhesion_billing: '', adhesion_payment_method: '', monthly_amount: 0, due_day: 0 };
 }
 const adhesion = cents(input.adhesionAmount);
 if (!(adhesion > 0) || adhesion > 100000000) throw new RuleError('Informe o valor da adesão.', 400);
 const monthly = cents(input.monthlyAmount);
 if (!(monthly > 0) || monthly > 100000000) throw new RuleError('Informe o valor da mensalidade.', 400);
 // A 1ª mensalidade é combinada com o cliente e escolhida pelo vendedor (decisão do usuário); as
 // outras 11 vencem no mesmo dia dos meses seguintes (cláusula 2.2: "todo dia X de cada mês").
 const firstDueDate = String(input.firstDueDate ?? '');
 if (!validDate(firstDueDate)) throw new RuleError('Informe a data da 1ª mensalidade (combinada com o cliente).', 400);
 if (firstDueDate < dayKey(now)) throw new RuleError('A 1ª mensalidade não pode estar no passado.', 400);
 const dueDay = Number(firstDueDate.slice(8, 10));
 // Dias 29–31 não existem em todos os meses: com eles, o vencimento "escorregaria" em alguns meses.
 if (dueDay > 28) throw new RuleError('Escolha a 1ª mensalidade entre os dias 1 e 28: os meses mais curtos não têm os dias 29 a 31.', 400);
 // Adesão é paga na loja, no ato da assinatura (cláusula 2.1); nunca vira boleto (decisão do usuário).
 if (input.adhesionBilling === 'BOLETO') throw new RuleError('A adesão é paga na loja, no ato da assinatura; ela não gera boleto.', 400);
 const method = String(input.adhesionPaymentMethod ?? '').trim();
 if (!(STORE_PAYMENT_METHODS as readonly string[]).includes(method)) throw new RuleError('Informe a forma de pagamento da adesão na loja (Dinheiro, Pix, Cartão de crédito ou Cartão de débito).', 400);
 return { total: 0, purchase_date: '', down_payment: 0, down_payment_method: '', installments: 0, first_due_date: firstDueDate, sale_channel: '', adhesion_amount: adhesion, adhesion_billing: 'LOJA', adhesion_payment_method: method, monthly_amount: monthly, due_day: dueDay };
}

async function loadUnitForOrder(db: D1Database, tenantId: string, unitId: string) {
 return db
  .prepare('SELECT u.id AS id, u.store_id AS storeId, u.product_id AS productId, u.status AS status, u.order_id AS orderId, p.kind AS kind FROM product_units u JOIN products p ON p.id = u.product_id WHERE u.id = ? AND u.tenant_id = ?')
  .bind(unitId, tenantId)
  .first<{ id: string; storeId: string; productId: string; status: string; orderId: string | null; kind: ProductKind }>();
}

export async function createOrder(db: D1Database, tenantId: string, input: OrderInput, actor: Actor, now = Date.now()): Promise<string> {
 requirePermission(actor.permissions, 'ORDER_CREATE');
 if (!(ORDER_TYPES as readonly string[]).includes(input.type)) throw new RuleError('Tipo de pedido inválido.', 400);
 const store = await getStore(db, tenantId, input.storeId);
 if (!store) throw new RuleError('Loja não encontrada.', 404);
 requireStoreAccess(actor, store.id);
 if (!storeHasModality(store, TYPE_MODALITY[input.type])) throw new RuleError(`A loja ${store.name} não tem a modalidade de ${TYPE_LABEL[input.type]} habilitada.`, 409);
 const customer = await db.prepare('SELECT id FROM customers WHERE id = ? AND tenant_id = ?').bind(input.customerId, tenantId).first<{ id: string }>();
 if (!customer) throw new RuleError('Cliente não encontrado. Cadastre o cliente antes de montar o pedido.', 404);
 const unit = await loadUnitForOrder(db, tenantId, input.unitId);
 if (!unit || unit.storeId !== store.id) throw new RuleError('Unidade não encontrada nesta loja.', 404);
 if (unit.kind !== TYPE_KIND[input.type]) throw new RuleError(input.type === 'VENDA' ? 'Escolha uma unidade de produto do tipo Moto.' : 'Escolha uma unidade de produto do tipo Locação.', 400);
 const terms = validateTerms(input.type, input, now);

 const id = crypto.randomUUID();
 // Reserva atômica: dois pedidos disputando a mesma unidade — só um consegue.
 const reserved = await db.prepare("UPDATE product_units SET status = 'RESERVED', order_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'AVAILABLE'").bind(id, now, unit.id, tenantId).run();
 if (reserved.meta.changes !== 1) throw new RuleError('Esta unidade já está reservada em outro pedido ou não está disponível.', 409);
 try {
  for (let attempt = 0; ; attempt++) {
   const next = await db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM orders WHERE tenant_id = ?').bind(tenantId).first<{ n: number }>();
   try {
    await db
     .prepare(
      `INSERT INTO orders (id, tenant_id, store_id, number, type, status, customer_id, seller_id, seller_name, product_id, unit_id, total, purchase_date, down_payment, down_payment_method, installments, first_due_date, sale_channel,
        adhesion_amount, adhesion_billing, adhesion_payment_method, monthly_amount, due_day, created_at, updated_at)
       VALUES (?,?,?,?,?,'OPEN',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
     )
     .bind(id, tenantId, store.id, Number(next?.n ?? 1), input.type, customer.id, actor.userId, actor.displayName, unit.productId, unit.id,
      terms.total, terms.purchase_date, terms.down_payment, terms.down_payment_method, terms.installments, terms.first_due_date, terms.sale_channel,
      terms.adhesion_amount, terms.adhesion_billing, terms.adhesion_payment_method, terms.monthly_amount, terms.due_day, now, now)
     .run();
    break;
   } catch (error) {
    // Número do pedido disputado por outra criação simultânea: tenta o próximo.
    if (attempt >= 4) throw error;
   }
  }
 } catch (error) {
  await db.prepare("UPDATE product_units SET status = 'AVAILABLE', order_id = NULL, updated_at = ? WHERE id = ? AND order_id = ?").bind(now, unit.id, id).run();
  throw error;
 }
 return id;
}

type OrderRow = { id: string; store_id: string; type: OrderType; status: string; customer_id: string; unit_id: string; product_id: string } & OrderTerms;

async function loadOrder(db: D1Database, tenantId: string, id: string): Promise<OrderRow> {
 const row = await db
  .prepare('SELECT id, store_id, type, status, customer_id, unit_id, product_id, total, purchase_date, down_payment, down_payment_method, installments, first_due_date, sale_channel, adhesion_amount, adhesion_billing, adhesion_payment_method, monthly_amount, due_day FROM orders WHERE id = ? AND tenant_id = ?')
  .bind(id, tenantId)
  .first<OrderRow>();
 if (!row) throw new RuleError('Pedido não encontrado.', 404);
 return { ...row, total: Number(row.total), down_payment: Number(row.down_payment), installments: Number(row.installments), adhesion_amount: Number(row.adhesion_amount), monthly_amount: Number(row.monthly_amount), due_day: Number(row.due_day) };
}

/** Pedido aberto pode ser corrigido (cliente, unidade, condições). Tipo e loja não mudam. */
export async function updateOrder(db: D1Database, tenantId: string, id: string, input: Omit<OrderInput, 'storeId' | 'type'>, actor: Actor, now = Date.now()): Promise<void> {
 requirePermission(actor.permissions, 'ORDER_CREATE');
 const order = await loadOrder(db, tenantId, id);
 requireStoreAccess(actor, order.store_id);
 if (order.status !== 'OPEN') throw new RuleError('Só pedidos em aberto podem ser alterados.', 409);
 await assertOrderContractsEditable(db, tenantId, id);
 const customer = await db.prepare('SELECT id FROM customers WHERE id = ? AND tenant_id = ?').bind(input.customerId, tenantId).first<{ id: string }>();
 if (!customer) throw new RuleError('Cliente não encontrado.', 404);
 const terms = validateTerms(order.type, { ...input, storeId: order.store_id, type: order.type }, now);
 let unitId = order.unit_id;
 let productId = order.product_id;
 if (input.unitId && input.unitId !== order.unit_id) {
  const unit = await loadUnitForOrder(db, tenantId, input.unitId);
  if (!unit || unit.storeId !== order.store_id) throw new RuleError('Unidade não encontrada nesta loja.', 404);
  if (unit.kind !== TYPE_KIND[order.type]) throw new RuleError('A unidade escolhida não é do tipo deste pedido.', 400);
  const reserved = await db.prepare("UPDATE product_units SET status = 'RESERVED', order_id = ?, updated_at = ? WHERE id = ? AND status = 'AVAILABLE'").bind(id, now, unit.id).run();
  if (reserved.meta.changes !== 1) throw new RuleError('Esta unidade já está reservada em outro pedido ou não está disponível.', 409);
  await db.prepare("UPDATE product_units SET status = 'AVAILABLE', order_id = NULL, updated_at = ? WHERE id = ? AND order_id = ?").bind(now, order.unit_id, id).run();
  unitId = unit.id;
  productId = unit.productId;
 }
 const result = await db
  .prepare(
   `UPDATE orders SET customer_id = ?, unit_id = ?, product_id = ?, total = ?, purchase_date = ?, down_payment = ?, down_payment_method = ?, installments = ?, first_due_date = ?, sale_channel = ?,
     adhesion_amount = ?, adhesion_billing = ?, adhesion_payment_method = ?, monthly_amount = ?, due_day = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'`,
  )
  .bind(customer.id, unitId, productId, terms.total, terms.purchase_date, terms.down_payment, terms.down_payment_method, terms.installments, terms.first_due_date, terms.sale_channel,
   terms.adhesion_amount, terms.adhesion_billing, terms.adhesion_payment_method, terms.monthly_amount, terms.due_day, now, id)
  .run();
 if (result.meta.changes !== 1) throw new RuleError('O pedido mudou de situação enquanto era alterado. Atualize a tela.', 409);
 // Os dados mudaram: contrato gerado e ainda não enviado deixa de valer (gere de novo).
 await invalidateOrderContracts(db, tenantId, id, 'ORDER_UPDATED', now);
}

export async function cancelOrder(db: D1Database, tenantId: string, id: string, reason: string, actor: Actor, now = Date.now()): Promise<void> {
 requirePermission(actor.permissions, 'ORDER_CANCEL');
 const order = await loadOrder(db, tenantId, id);
 requireStoreAccess(actor, order.store_id);
 const text = String(reason ?? '').trim();
 if (text.length < 5) throw new RuleError('Informe o motivo do cancelamento (mínimo 5 caracteres).', 400);
 if (order.status !== 'OPEN') throw new RuleError(order.status === 'COMPLETED' ? 'Pedido já finalizado: cancele a venda correspondente (a unidade volta ao estoque).' : 'Pedido já cancelado.', 409);
 await assertOrderContractsEditable(db, tenantId, id);
 const claimed = await db.prepare("UPDATE orders SET status = 'CANCELLED', cancel_reason = ?, cancelled_at = ?, cancelled_by = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'").bind(text, now, actor.userId, now, id).run();
 if (claimed.meta.changes !== 1) throw new RuleError('O pedido mudou de situação. Atualize a tela.', 409);
 await db.prepare("UPDATE product_units SET status = 'AVAILABLE', order_id = NULL, updated_at = ? WHERE id = ? AND order_id = ?").bind(now, order.unit_id, id).run();
 await invalidateOrderContracts(db, tenantId, id, 'ORDER_CANCELLED', now);
}

export async function addOrderNote(db: D1Database, tenantId: string, orderId: string, text: string, actor: Actor, now = Date.now()): Promise<string> {
 requirePermission(actor.permissions, 'ORDER_VIEW');
 const order = await loadOrder(db, tenantId, orderId);
 requireStoreAccess(actor, order.store_id);
 const body = String(text ?? '').trim();
 if (body.length < 1 || body.length > 2000) throw new RuleError('A observação deve ter entre 1 e 2000 caracteres.', 400);
 const id = crypto.randomUUID();
 await db.prepare('INSERT INTO order_notes (id, tenant_id, order_id, user_id, author, text, created_at) VALUES (?,?,?,?,?,?,?)').bind(id, tenantId, orderId, actor.userId, actor.displayName, body, now).run();
 return id;
}

/**
 * Finaliza o pedido na loja.
 * VENDA: gera a venda comum no caixa aberto de quem finaliza (entrada recebida na forma
 * informada + parcelas como "Boleto"), baixa o estoque e marca a unidade como vendida.
 * LOCAÇÃO: entrega o equipamento (unidade RENTED, estoque sai com RENTAL_OUT); adesão paga na
 * loja em dinheiro entra no caixa como RECEIPT para o fechamento bater.
 */
export async function completeOrder(db: D1Database, tenantId: string, id: string, actor: Actor, now = Date.now()): Promise<{ saleId: string | null }> {
 requirePermission(actor.permissions, 'ORDER_COMPLETE');
 const order = await loadOrder(db, tenantId, id);
 requireStoreAccess(actor, order.store_id);
 if (order.status !== 'OPEN') throw new RuleError(order.status === 'COMPLETED' ? 'Pedido já finalizado.' : 'Pedido cancelado não pode ser finalizado.', 409);
 // Pedidos de locação criados antes da regra atual: pedir a correção em vez de presumir.
 if (order.type === 'LOCACAO' && (!order.first_due_date || order.adhesion_billing !== 'LOJA')) throw new RuleError('Edite o pedido antes de finalizar: informe a data da 1ª mensalidade e a forma de pagamento da adesão na loja (a adesão não gera mais boleto).', 409);
 const customer = await db.prepare('SELECT name, document FROM customers WHERE id = ? AND tenant_id = ?').bind(order.customer_id, tenantId).first<{ name: string; document: string }>();
 if (!customer) throw new RuleError('Cliente do pedido não encontrado.', 404);
 const session = await findOpenSessionForUser(db, tenantId, order.store_id, actor.userId);
 if (!session) throw new RuleError('Abra seu caixa nesta loja antes de finalizar o pedido.', 409);

 // Reivindica o pedido antes de mexer em venda/estoque: duas finalizações simultâneas não passam.
 const claimed = await db.prepare("UPDATE orders SET status = 'COMPLETING', updated_at = ? WHERE id = ? AND status = 'OPEN'").bind(now, id).run();
 if (claimed.meta.changes !== 1) throw new RuleError('O pedido mudou de situação. Atualize a tela.', 409);
 try {
  if (order.type === 'VENDA') {
   const payments: { method: string; amount: number }[] = [];
   if (order.down_payment > 0) payments.push({ method: order.down_payment_method, amount: order.down_payment });
   if (order.installments > 0) payments.push({ method: 'Boleto', amount: order.total - order.down_payment });
   const saleId = await createSale(db, tenantId, { storeId: order.store_id, items: [{ productId: order.product_id, qty: 1 }], customer: customer.name, document: customer.document, payments }, actor, now, { fromOrder: { unitPrice: order.total } });
   await db.batch([
    db.prepare("UPDATE product_units SET status = 'SOLD', updated_at = ? WHERE id = ? AND order_id = ?").bind(now, order.unit_id, id),
    db.prepare("UPDATE orders SET status = 'COMPLETED', sale_id = ?, completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ?").bind(saleId, now, actor.userId, now, id),
   ]);
   return { saleId };
  }
  const stockRow = await db.prepare('SELECT quantity FROM inventories WHERE tenant_id = ? AND store_id = ? AND product_id = ?').bind(tenantId, order.store_id, order.product_id).first<{ quantity: number }>();
  const previous = Number(stockRow?.quantity ?? 0);
  const statements = [
   db.prepare('UPDATE inventories SET quantity = quantity - 1 WHERE tenant_id = ? AND store_id = ? AND product_id = ?').bind(tenantId, order.store_id, order.product_id),
   db.prepare('INSERT INTO stock_movements (id, tenant_id, store_id, product_id, type, quantity, previous_quantity, new_quantity, reference_type, reference_id, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), tenantId, order.store_id, order.product_id, 'RENTAL_OUT', -1, previous, previous - 1, 'ORDER', id, actor.userId, now),
   db.prepare("UPDATE product_units SET status = 'RENTED', updated_at = ? WHERE id = ? AND order_id = ?").bind(now, order.unit_id, id),
   db.prepare("UPDATE orders SET status = 'COMPLETED', completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ?").bind(now, actor.userId, now, id),
  ];
  if (order.adhesion_billing === 'LOJA' && order.adhesion_payment_method === 'Dinheiro') {
   statements.push(db.prepare('INSERT INTO cash_movements (id, tenant_id, cash_session_id, type, amount, reason, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), tenantId, session.id, 'RECEIPT', order.adhesion_amount, `Adesão da locação (pedido ${id.slice(0, 8)})`, actor.userId, now));
  }
  try {
   await db.batch(statements);
  } catch {
   throw new RuleError('Estoque insuficiente para entregar este equipamento.', 409);
  }
  return { saleId: null };
 } catch (error) {
  await db.prepare("UPDATE orders SET status = 'OPEN', updated_at = ? WHERE id = ? AND status = 'COMPLETING'").bind(now, id).run();
  throw error;
 }
}

export type OrderRecord = {
 id: string; number: number; storeId: string; type: OrderType; status: string; customerId: string; customerName: string; customerDocument: string;
 sellerId: string; sellerName: string; productId: string; productName: string; unitId: string; serial: string; color: string; memory: string; condition: string;
 total: number; purchaseDate: string; downPayment: number; downPaymentMethod: string; installments: number; firstDueDate: string; saleChannel: string;
 adhesionAmount: number; adhesionBilling: string; adhesionPaymentMethod: string; monthlyAmount: number; dueDay: number;
 saleId: string | null; cancelReason: string; createdAt: number; updatedAt: number; completedAt: number | null; cancelledAt: number | null;
 notes: { id: string; author: string; text: string; createdAt: number }[];
};

export async function listOrders(db: D1Database, tenantId: string, actor: Actor): Promise<OrderRecord[]> {
 if (!actor.permissions.has('ORDER_VIEW')) return [];
 const rows = await db
  .prepare(
   `SELECT o.id AS id, o.number AS number, o.store_id AS storeId, o.type AS type, o.status AS status, o.customer_id AS customerId, c.name AS customerName, c.document AS customerDocument,
           o.seller_id AS sellerId, o.seller_name AS sellerName, o.product_id AS productId, p.name AS productName, o.unit_id AS unitId, u.serial AS serial, u.color AS color,
           u.memory AS memory, u.condition AS condition, o.total AS total, o.purchase_date AS purchaseDate, o.down_payment AS downPayment, o.down_payment_method AS downPaymentMethod,
           o.installments AS installments, o.first_due_date AS firstDueDate, o.sale_channel AS saleChannel, o.adhesion_amount AS adhesionAmount, o.adhesion_billing AS adhesionBilling,
           o.adhesion_payment_method AS adhesionPaymentMethod, o.monthly_amount AS monthlyAmount, o.due_day AS dueDay, o.sale_id AS saleId, o.cancel_reason AS cancelReason,
           o.created_at AS createdAt, o.updated_at AS updatedAt, o.completed_at AS completedAt, o.cancelled_at AS cancelledAt
    FROM orders o JOIN customers c ON c.id = o.customer_id JOIN products p ON p.id = o.product_id JOIN product_units u ON u.id = o.unit_id
    WHERE o.tenant_id = ? ORDER BY o.number DESC`,
  )
  .bind(tenantId)
  .all<Omit<OrderRecord, 'notes'>>();
 const visible = (rows.results ?? []).filter((o) => !actor.storeId || o.storeId === actor.storeId);
 const notes = await db.prepare('SELECT id, order_id AS orderId, author, text, created_at AS createdAt FROM order_notes WHERE tenant_id = ? ORDER BY created_at ASC').bind(tenantId).all<{ id: string; orderId: string; author: string; text: string; createdAt: number }>();
 const byOrder = new Map<string, OrderRecord['notes']>();
 for (const n of notes.results ?? []) {
  const list = byOrder.get(n.orderId) ?? [];
  list.push({ id: n.id, author: n.author, text: n.text, createdAt: Number(n.createdAt) });
  byOrder.set(n.orderId, list);
 }
 return visible.map((o) => ({
  ...o,
  number: Number(o.number), total: Number(o.total), downPayment: Number(o.downPayment), installments: Number(o.installments), adhesionAmount: Number(o.adhesionAmount),
  monthlyAmount: Number(o.monthlyAmount), dueDay: Number(o.dueDay), createdAt: Number(o.createdAt), updatedAt: Number(o.updatedAt),
  completedAt: o.completedAt == null ? null : Number(o.completedAt), cancelledAt: o.cancelledAt == null ? null : Number(o.cancelledAt),
  notes: byOrder.get(o.id) ?? [],
 }));
}

/** Chamado por cancelSale: venda que veio de pedido devolve a unidade e cancela o pedido. */
export async function releaseOrderForCancelledSale(db: D1Database, tenantId: string, saleId: string, actor: Actor, now = Date.now()): Promise<void> {
 const order = await db.prepare("SELECT id, unit_id AS unitId FROM orders WHERE tenant_id = ? AND sale_id = ? AND status = 'COMPLETED'").bind(tenantId, saleId).first<{ id: string; unitId: string }>();
 if (!order) return;
 await db.batch([
  db.prepare("UPDATE product_units SET status = 'AVAILABLE', order_id = NULL, updated_at = ? WHERE id = ?").bind(now, order.unitId),
  db.prepare("UPDATE orders SET status = 'CANCELLED', cancel_reason = ?, cancelled_at = ?, cancelled_by = ?, updated_at = ? WHERE id = ?").bind('Venda do pedido cancelada', now, actor.userId, now, order.id),
 ]);
}
