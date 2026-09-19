import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { registerAccount, hashPassword } from '../lib/auth/service.ts';
import { loadPermissions } from '../lib/authz/service.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession, closeSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale, cancelSale, listSalesForSnapshot } from '../lib/sales/service.ts';
import { returnSale } from '../lib/sales/returns.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import { getSalesReport, getCashReport } from '../lib/reports/service.ts';
import { generateNFeForSale } from '../lib/fiscal/service.ts';
import type { Actor } from '../lib/domain.ts';

// §54 — devoluções e estornos: parcial/total, estorno financeiro, retorno (ou não) ao
// estoque, movimentação compensatória, sem apagar a venda e sem estornar em dobro.

const PASSWORD = 'senha-forte-123';
const plan = { status: 'active', accessUntil: 9_999_999_999_999, maxStores: 3 };

async function addMember(db: D1Database, tenantId: string, opts: { email: string; roleId: string; legacyRole: string; name: string }) {
 const userId = crypto.randomUUID();
 await db.prepare('INSERT INTO users (id, display_name, email, password_hash, created_at) VALUES (?,?,?,?,?)').bind(userId, opts.name, opts.email, await hashPassword(PASSWORD), 1).run();
 await db.prepare('INSERT INTO memberships (user_id, account_id, role, store_id, display_name) VALUES (?,?,?,NULL,?)').bind(userId, tenantId, opts.legacyRole, opts.name).run();
 await db.prepare('INSERT INTO user_tenant_roles (id, user_id, tenant_id, role_id) VALUES (?,?,?,?)').bind(crypto.randomUUID(), userId, tenantId, opts.roleId).run();
 return userId;
}
async function actorFor(db: D1Database, tenantId: string, userId: string, legacyRole: string, name: string, storeId: string | null = null): Promise<Actor> {
 return { userId, displayName: name, role: legacyRole, storeId, permissions: await loadPermissions(db, userId, tenantId, legacyRole) };
}

async function fixture() {
 const db = createFakeD1();
 const reg = await registerAccount(db, { accountName: 'Grupo Teste', displayName: 'Dona Ana', email: 'ana@teste.com', password: PASSWORD });
 const tenantId = reg.accountId;
 const owner = await actorFor(db, tenantId, reg.userId, 'admin', 'Dona Ana');
 const storeId = await createStore(db, tenantId, { name: 'Loja Centro', legalName: 'LOJA CENTRO LTDA', cnpj: '12345678000190', ie: '123456789110', uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' } as never, owner);
 const productA = await createProduct(db, tenantId, { name: 'Camiseta', sku: 'CAM-1', price: 5000, cost: 2000, minimum: 1, unit: 'UN' } as never, owner);
 const productB = await createProduct(db, tenantId, { name: 'Boné', sku: 'BON-1', price: 3333, cost: 1000, minimum: 1, unit: 'UN' } as never, owner);
 await receiveStock(db, { tenantId, storeId, productId: productA, quantity: 100, userId: reg.userId, reason: 'Estoque inicial' }, owner);
 await receiveStock(db, { tenantId, storeId, productId: productB, quantity: 100, userId: reg.userId, reason: 'Estoque inicial' }, owner);
 const operatorId = await addMember(db, tenantId, { email: 'op@teste.com', roleId: 'ROLE_OPERADOR_CAIXA', legacyRole: 'operator', name: 'Operador Beto' });
 const managerId = await addMember(db, tenantId, { email: 'gerente@teste.com', roleId: 'ROLE_GERENTE', legacyRole: 'operator', name: 'Gerente Carla' });
 const operator = await actorFor(db, tenantId, operatorId, 'operator', 'Operador Beto', storeId);
 const manager = await actorFor(db, tenantId, managerId, 'operator', 'Gerente Carla', storeId);
 await openSession(db, tenantId, storeId, 10000, operator);
 return { db, tenantId, storeId, productA, productB, owner, operator, manager, ownerId: reg.userId, operatorId, managerId };
}
type F = Awaited<ReturnType<typeof fixture>>;

const stockOf = async (f: F, productId: string) => Number((await f.db.prepare('SELECT quantity FROM inventories WHERE store_id = ? AND product_id = ?').bind(f.storeId, productId).first<{ quantity: number }>())?.quantity);
const saleRow = (f: F, id: string) => f.db.prepare('SELECT status, total, returned_total AS returnedTotal FROM sales WHERE id = ?').bind(id).first<{ status: string; total: number; returnedTotal: number }>();
const openManagerCash = (f: F, opening = 20000) => openSession(f.db, f.tenantId, f.storeId, opening, f.manager);
/** Venda padrão: Camiseta x2 (5000) + Boné x1 (3333) = 13333. */
const sellBoth = (f: F, extra: Record<string, unknown> = { payment: 'Dinheiro' }) =>
 createSale(f.db, f.tenantId, { storeId: f.storeId, items: [{ productId: f.productA, qty: 2 }, { productId: f.productB, qty: 1 }], customer: '', document: '', ...extra } as never, f.operator);

test('devolução parcial com retorno ao estoque e estorno em dinheiro: compensa estoque, tira do caixa e mantém a venda', async () => {
 const f = await fixture();
 const saleId = await sellBoth(f);
 assert.equal(await stockOf(f, f.productA), 98);
 await openManagerCash(f);
 const returnId = await returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productA, qty: 1, restock: true }], reason: 'Tamanho errado', refundMethod: 'Dinheiro' }, f.manager);

 assert.equal(await stockOf(f, f.productA), 99, 'uma unidade voltou');
 assert.equal(await stockOf(f, f.productB), 99, 'o que não foi devolvido continua baixado');
 const movement = await f.db.prepare("SELECT type, quantity, reference_type AS referenceType, reference_id AS referenceId FROM stock_movements WHERE type = 'RETURN'").bind().first<{ type: string; quantity: number; referenceType: string; referenceId: string }>();
 assert.deepEqual([movement?.type, Number(movement?.quantity), movement?.referenceType, movement?.referenceId], ['RETURN', 1, 'sale_return', returnId]);

 const sale = await saleRow(f, saleId);
 assert.equal(sale?.status, 'COMPLETED', 'devolução parcial não cancela a venda');
 assert.equal(Number(sale?.total), 13333, 'a venda original não é alterada');
 assert.equal(Number(sale?.returnedTotal), 5000);
 const ret = await f.db.prepare('SELECT total, refund_method AS method, reason FROM sale_returns WHERE id = ?').bind(returnId).first<{ total: number; method: string; reason: string }>();
 assert.deepEqual([Number(ret?.total), ret?.method, ret?.reason], [5000, 'Dinheiro', 'Tamanho errado']);

 const cash = await f.db.prepare("SELECT type, amount FROM cash_movements WHERE type = 'REFUND'").bind().first<{ type: string; amount: number }>();
 assert.equal(Number(cash?.amount), 5000);
 const managerSession = await f.db.prepare('SELECT id FROM cash_sessions WHERE user_id = ?').bind(f.managerId).first<{ id: string }>();
 await closeSession(f.db, f.tenantId, managerSession!.id, 15000, f.manager);
 const closed = await f.db.prepare('SELECT expected_amount AS expected, difference FROM cash_sessions WHERE id = ?').bind(managerSession!.id).first<{ expected: number; difference: number }>();
 assert.equal(Number(closed?.expected), 15000, 'abertura 20000 - estorno 5000');
 assert.equal(Number(closed?.difference), 0);
});

test('devolução sem retorno ao estoque (avaria): registra, estorna, mas não mexe no saldo', async () => {
 const f = await fixture();
 const saleId = await sellBoth(f, { payment: 'Pix' });
 await returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productB, qty: 1, restock: false }], reason: 'Produto danificado', refundMethod: 'Pix' }, f.manager);
 assert.equal(await stockOf(f, f.productB), 99);
 const moves = await f.db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE type = 'RETURN'").bind().first<{ n: number }>();
 assert.equal(Number(moves?.n), 0);
 const item = await f.db.prepare('SELECT restock, amount FROM sale_return_items').bind().first<{ restock: number; amount: number }>();
 assert.deepEqual([Number(item?.restock), Number(item?.amount)], [0, 3333]);
 const noCash = await f.db.prepare("SELECT COUNT(*) AS n FROM cash_movements WHERE type = 'REFUND'").bind().first<{ n: number }>();
 assert.equal(Number(noCash?.n), 0, 'estorno em Pix não mexe no caixa físico');
});

test('venda com desconto: cada devolução estorna o líquido proporcional e a última leva o resto exato', async () => {
 const f = await fixture();
 // 2 x 5000 = 10000, desconto de 1001 (autorizado pelo OWNER) -> líquido 8999
 const saleId = await createSale(f.db, f.tenantId, { storeId: f.storeId, items: [{ productId: f.productA, qty: 2 }], customer: '', document: '', payment: 'Pix', discount: { amount: 1001, reason: 'Fidelidade' }, authorization: { email: 'ana@teste.com', password: PASSWORD } } as never, f.operator);
 assert.equal(Number((await saleRow(f, saleId))?.total), 8999);
 const first = await returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productA, qty: 1, restock: true }], reason: 'Primeira', refundMethod: 'Pix' }, f.manager);
 assert.equal(Number((await f.db.prepare('SELECT total FROM sale_returns WHERE id = ?').bind(first).first<{ total: number }>())?.total), 4499);
 assert.equal((await saleRow(f, saleId))?.status, 'COMPLETED');
 const second = await returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productA, qty: 1, restock: true }], reason: 'Segunda', refundMethod: 'Pix' }, f.manager);
 assert.equal(Number((await f.db.prepare('SELECT total FROM sale_returns WHERE id = ?').bind(second).first<{ total: number }>())?.total), 4500, 'resto exato');
 const sale = await saleRow(f, saleId);
 assert.equal(Number(sale?.returnedTotal), 8999, 'devolvido = exatamente o que foi pago');
 assert.equal(sale?.status, 'REFUNDED');
 await assert.rejects(() => returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productA, qty: 1, restock: true }], reason: 'Terceira', refundMethod: 'Pix' }, f.manager), /já foram devolvidos/);
});

test('não devolve mais do que foi vendido, produto alheio nem quantidade inválida', async () => {
 const f = await fixture();
 const saleId = await sellBoth(f);
 await openManagerCash(f);
 const ret = (items: { productId: string; qty: number; restock: boolean }[]) => returnSale(f.db, f.tenantId, { saleId, items, reason: 'Teste', refundMethod: 'Dinheiro' }, f.manager);
 await assert.rejects(() => ret([{ productId: f.productA, qty: 3, restock: true }]), /só 2 unidade/);
 await assert.rejects(() => ret([{ productId: f.productA, qty: 0, restock: true }]), /inválida/);
 await assert.rejects(() => ret([{ productId: 'nao-existe', qty: 1, restock: true }]), /não pertence/);
 await assert.rejects(() => ret([]), /ao menos um item/);
 await assert.rejects(() => ret([{ productId: f.productA, qty: 1, restock: true }, { productId: f.productA, qty: 1, restock: true }]), /repetido/);
 await ret([{ productId: f.productA, qty: 2, restock: true }]);
 await assert.rejects(() => ret([{ productId: f.productA, qty: 1, restock: true }]), /só 0 unidade/);
 assert.equal(await stockOf(f, f.productA), 100, 'nada foi devolvido em dobro');
});

test('estorno não passa do que foi pago naquela forma de pagamento', async () => {
 const f = await fixture();
 // total 13333 = 4000 Pix + 9333 Dinheiro
 const saleId = await sellBoth(f, { payments: [{ method: 'Pix', amount: 4000 }, { method: 'Dinheiro', amount: 9333 }] });
 await openManagerCash(f);
 const ret = (qty: number, method: string) => returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productA, qty, restock: true }], reason: 'Teste', refundMethod: method }, f.manager);
 await assert.rejects(() => ret(2, 'Dinheiro'), /passa do que foi pago em Dinheiro/); // 10000 > 9333
 await assert.rejects(() => ret(1, 'Pix'), /passa do que foi pago em Pix/); // 5000 > 4000
 await assert.rejects(() => ret(1, 'Cartão'), /passa do que foi pago em Cartão/); // pago 0
 await ret(1, 'Dinheiro'); // 5000 <= 9333 ok
 await assert.rejects(() => ret(1, 'Dinheiro'), /passa do que foi pago em Dinheiro/); // 5000 > 9333-5000
});

test('estorno em dinheiro exige o caixa aberto do próprio usuário; em Pix não exige', async () => {
 const f = await fixture();
 const saleId = await sellBoth(f, { payments: [{ method: 'Pix', amount: 3333 }, { method: 'Dinheiro', amount: 10000 }] });
 const ret = (method: string, productId: string) => returnSale(f.db, f.tenantId, { saleId, items: [{ productId, qty: 1, restock: true }], reason: 'Teste', refundMethod: method }, f.manager);
 await assert.rejects(() => ret('Dinheiro', f.productA), /Abra seu caixa/);
 assert.equal(Number((await saleRow(f, saleId))?.returnedTotal), 0, 'falha não deixa a venda marcada');
 await ret('Pix', f.productB);
 assert.equal(Number((await saleRow(f, saleId))?.returnedTotal), 3333);
});

test('permissão: operador de caixa não devolve; forma de estorno e motivo são validados', async () => {
 const f = await fixture();
 const saleId = await sellBoth(f);
 const base = { saleId, items: [{ productId: f.productA, qty: 1, restock: true }], reason: 'Teste', refundMethod: 'Dinheiro' };
 await assert.rejects(() => returnSale(f.db, f.tenantId, base, f.operator), /permissão/);
 await assert.rejects(() => returnSale(f.db, f.tenantId, { ...base, refundMethod: 'Cheque' }, f.manager), /Forma de estorno/);
 await assert.rejects(() => returnSale(f.db, f.tenantId, { ...base, reason: 'ab' }, f.manager), /motivo/);
 await assert.rejects(() => returnSale(f.db, f.tenantId, { ...base, saleId: 'nao-existe' }, f.manager), /não encontrada/);
});

test('cancelamento e devolução são fluxos diferentes: cancelar depois de devolver é bloqueado, devolver venda cancelada também', async () => {
 const f = await fixture();
 const saleId = await sellBoth(f);
 await openManagerCash(f);
 await returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productA, qty: 1, restock: true }], reason: 'Teste', refundMethod: 'Dinheiro' }, f.manager);
 await assert.rejects(() => cancelSale(f.db, f.tenantId, saleId, f.owner), /já possui devolução/);
 const other = await sellBoth(f);
 await cancelSale(f.db, f.tenantId, other, f.owner);
 await assert.rejects(() => returnSale(f.db, f.tenantId, { saleId: other, items: [{ productId: f.productA, qty: 1, restock: true }], reason: 'Teste', refundMethod: 'Dinheiro' }, f.manager), /cancelada/);
});

test('fiscal: documento ativo (gerado/assinado/autorizado) bloqueia a devolução; rejeitado ou cancelado não', async () => {
 const f = await fixture();
 await openManagerCash(f);
 const ret = (saleId: string) => returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productA, qty: 1, restock: true }], reason: 'Teste', refundMethod: 'Dinheiro' }, f.manager);
 const withDoc = async (status: string) => {
  const saleId = await sellBoth(f);
  // MOCK de documento fiscal (só em teste): linha mínima em fiscal_documents com o status desejado.
  await f.db.prepare('INSERT INTO fiscal_documents (id, tenant_id, store_id, sale_id, model, series, number, access_key, status, issued_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(), f.tenantId, f.storeId, saleId, '55', 1, Math.floor(Math.random() * 1e6), String(Math.floor(Math.random() * 1e15)).padStart(44, '3'), status, 1).run();
  return saleId;
 };
 await assert.rejects(async () => ret(await withDoc('AUTHORIZED')), /autorizada. A devolução exige nota fiscal de devolução/);
 await assert.rejects(async () => ret(await withDoc('GENERATED')), /em andamento \(GENERATED\)/);
 await assert.rejects(async () => ret(await withDoc('SIGNED')), /em andamento \(SIGNED\)/);
 assert.ok(await ret(await withDoc('REJECTED')));
 assert.ok(await ret(await withDoc('CANCELLED')));
});

test('fiscal: venda com devolução não gera NF-e pelo valor original', async () => {
 const f = await fixture();
 const saleId = await sellBoth(f, { payment: 'Pix' });
 await returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productB, qty: 1, restock: true }], reason: 'Teste', refundMethod: 'Pix' }, f.manager);
 await assert.rejects(() => generateNFeForSale(f.db, f.tenantId, saleId, f.owner), /devolução registrada/);
});

test('duas devoluções simultâneas da mesma unidade: só uma passa (sem estorno em dobro)', async () => {
 const f = await fixture();
 const saleId = await createSale(f.db, f.tenantId, { storeId: f.storeId, items: [{ productId: f.productA, qty: 1 }], customer: '', document: '', payment: 'Pix' } as never, f.operator);
 const attempt = () => returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productA, qty: 1, restock: true }], reason: 'Simultânea', refundMethod: 'Pix' }, f.manager);
 const results = await Promise.allSettled([attempt(), attempt()]);
 assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
 assert.equal(await stockOf(f, f.productA), 100, 'o estoque voltou uma vez só');
 const refunds = await f.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM sale_returns').bind().first<{ n: number; total: number }>();
 assert.deepEqual([Number(refunds?.n), Number(refunds?.total)], [1, 5000]);
});

test('se a gravação falha depois da reserva, a venda volta ao estado anterior (nada fica marcado como devolvido)', async () => {
 const f = await fixture();
 const saleId = await sellBoth(f, { payment: 'Pix' });
 // MOCK de banco (só em teste): idêntico ao real, exceto que a transação (batch) sempre falha.
 const broken = { prepare: (sql: string) => f.db.prepare(sql), batch: async () => { throw new Error('falha simulada'); } } as unknown as D1Database;
 await assert.rejects(() => returnSale(broken, f.tenantId, { saleId, items: [{ productId: f.productA, qty: 2, restock: true }], reason: 'Teste', refundMethod: 'Pix' }, f.manager), /falha simulada/);
 const sale = await saleRow(f, saleId);
 assert.deepEqual([sale?.status, Number(sale?.returnedTotal)], ['COMPLETED', 0]);
 assert.equal(await stockOf(f, f.productA), 98);
 // e a devolução real continua possível
 assert.ok(await returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productA, qty: 2, restock: true }], reason: 'Teste', refundMethod: 'Pix' }, f.manager));
});

test('snapshot da venda lista as devoluções e a quantidade já devolvida por item', async () => {
 const f = await fixture();
 const saleId = await sellBoth(f, { payment: 'Pix' });
 await returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productA, qty: 1, restock: true }], reason: 'Tamanho errado', refundMethod: 'Pix' }, f.manager);
 const [sale] = await listSalesForSnapshot(f.db, f.tenantId);
 assert.equal(sale.returnedTotal, 5000);
 assert.equal(sale.returns.length, 1);
 assert.equal(sale.returns[0].reason, 'Tamanho errado');
 assert.deepEqual(sale.returns[0].items.map((i) => [i.name, i.qty, i.amount, i.restock]), [['Camiseta', 1, 5000, true]]);
 assert.equal(sale.items.find((i) => i.name === 'Camiseta')?.returnedQty, 1);
 assert.equal(sale.items.find((i) => i.name === 'Boné')?.returnedQty, 0);
 assert.equal(sale.total, 13333);
});

test('relatórios: vendas mostram devoluções e valor líquido; caixa mostra os estornos em dinheiro', async () => {
 const f = await fixture();
 const saleId = await sellBoth(f);
 await openManagerCash(f);
 await returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productA, qty: 2, restock: true }], reason: 'Teste', refundMethod: 'Dinheiro' }, f.manager);
 const sales = await getSalesReport(f.db, f.tenantId, f.owner);
 assert.deepEqual([sales.totals.count, sales.totals.total, sales.totals.returnsCount, sales.totals.returnsTotal, sales.totals.netTotal, sales.totals.discountTotal], [1, 13333, 1, 10000, 3333, 0]);
 const cash = await getCashReport(f.db, f.tenantId, f.owner);
 assert.equal(cash.totals.totalRefunds, 10000);
 assert.equal(cash.sessions.find((s) => s.operator === 'Gerente Carla')?.refunds, 10000);
 // devolução total: a venda vira REFUNDED e continua no bruto (senão o líquido descontaria em dobro)
 await returnSale(f.db, f.tenantId, { saleId, items: [{ productId: f.productB, qty: 1, restock: true }], reason: 'Resto', refundMethod: 'Dinheiro' }, f.manager);
 const after = await getSalesReport(f.db, f.tenantId, f.owner);
 assert.deepEqual([after.totals.total, after.totals.returnsTotal, after.totals.netTotal], [13333, 13333, 0]);
});

test('comando sale.return: passa pelo dispatcher, exige permissão e gera auditoria da devolução', async () => {
 const f = await fixture();
 const saleId = await sellBoth(f, { payment: 'Pix' });
 const command = { type: 'sale.return', saleId, items: [{ productId: f.productA, qty: 1, restock: true }], reason: 'Tamanho errado', refundMethod: 'Pix' } as never;
 await assert.rejects(() => dispatchCommand(f.db, f.tenantId, f.operator, plan, command), /permissão/);
 const id = await dispatchCommand(f.db, f.tenantId, f.manager, plan, command, Date.now(), { ip: '203.0.113.9', correlationId: 'corr-2' });
 assert.ok(id);
 const audit = await f.db.prepare("SELECT entity, entity_id AS entityId, description FROM audit_logs WHERE action = 'sale.return'").bind().first<{ entity: string; entityId: string; description: string }>();
 assert.deepEqual([audit?.entity, audit?.entityId], ['sale_return', id]);
 assert.match(audit?.description ?? '', /Tamanho errado/);
});
