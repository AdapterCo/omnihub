import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession } from '../lib/cash/service.ts';
import { receiveStock, getStock } from '../lib/inventory/service.ts';
import { createSale, printSale, cancelSale, listSalesForSnapshot } from '../lib/sales/service.ts';

const owner = { userId: 'owner-1', displayName: 'Dona', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };
const operator = { userId: 'operator-1', displayName: 'Operador', role: 'operator', storeId: '', permissions: permissionsForRole('OPERADOR_CAIXA') };

async function fixture() {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'trial',9999999999999,3,0)").bind().run();
 const storeA = await createStore(db, 't1', { name: 'Loja A' }, owner);
 const product = await createProduct(db, 't1', { name: 'Produto A', sku: 'SKU-A', price: 1990, cost: 1000, minimum: 1, unit: 'UN' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 10, userId: owner.userId, reason: 'Inicial' }, owner);
 const op = { ...operator, storeId: storeA };
 await openSession(db, 't1', storeA, 0, op);
 return { db, storeA, product, op };
}

test('Venda exige caixa aberto e baixa estoque; preço vem do servidor', async () => {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'trial',9999999999999,3,0)").bind().run();
 const storeA = await createStore(db, 't1', { name: 'Loja A' }, owner);
 const product = await createProduct(db, 't1', { name: 'Produto A', sku: 'SKU-A', price: 1990, cost: 1000, minimum: 1, unit: 'UN' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 10, userId: owner.userId, reason: 'Inicial' }, owner);
 const op = { ...operator, storeId: storeA };
 await assert.rejects(() => createSale(db, 't1', { storeId: storeA, items: [{ productId: product, qty: 2 }], customer: '', document: '', payment: 'Dinheiro' }, op), /Abra seu caixa/);
 await openSession(db, 't1', storeA, 0, op);
 const id = await createSale(db, 't1', { storeId: storeA, items: [{ productId: product, qty: 2 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 assert.ok(id);
 assert.equal(await getStock(db, 't1', storeA, product), 8);
});

test('Pagamento misto: soma de payments precisa bater com o total, senão rejeita', async () => {
 const { db, storeA, product, op } = await fixture();
 await assert.rejects(
  () => createSale(db, 't1', { storeId: storeA, items: [{ productId: product, qty: 1 }], customer: '', document: '', payments: [{ method: 'Dinheiro', amount: 500 }, { method: 'Pix', amount: 1000 }] }, op),
  /não confere/,
 );
 const id = await createSale(db, 't1', { storeId: storeA, items: [{ productId: product, qty: 1 }], customer: '', document: '', payments: [{ method: 'Dinheiro', amount: 990 }, { method: 'Pix', amount: 1000 }] }, op);
 const payments = await db.prepare('SELECT method, amount FROM sale_payments WHERE sale_id = ? ORDER BY method').bind(id).all<{ method: string; amount: number }>();
 assert.deepEqual(payments.results?.map((p) => ({ ...p })), [{ method: 'Dinheiro', amount: 990 }, { method: 'Pix', amount: 1000 }]);
});

test('Sem estoque suficiente, a venda não grava nada (nem sale nem itens nem estoque)', async () => {
 const { db, storeA, product, op } = await fixture();
 await assert.rejects(() => createSale(db, 't1', { storeId: storeA, items: [{ productId: product, qty: 99 }], customer: '', document: '', payment: 'Dinheiro' }, op), /insuficiente/);
 assert.equal(await getStock(db, 't1', storeA, product), 10);
 const count = await db.prepare('SELECT COUNT(*) AS n FROM sales').bind().first<{ n: number }>();
 assert.equal(count?.n, 0);
});

test('Duas vendas concorrentes disputando o último item: só uma consegue (locking real via CHECK + batch)', async () => {
 const { db, storeA, product, op } = await fixture();
 // reduz para 1 unidade disponível
 await createSale(db, 't1', { storeId: storeA, items: [{ productId: product, qty: 9 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 assert.equal(await getStock(db, 't1', storeA, product), 1);
 const attempt = () => createSale(db, 't1', { storeId: storeA, items: [{ productId: product, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 const results = await Promise.allSettled([attempt(), attempt()]);
 assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
 assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
 assert.equal(await getStock(db, 't1', storeA, product), 0);
});

test('Reimpressão não altera estoque nem total; cancelamento devolve o estoque', async () => {
 const { db, storeA, product, op } = await fixture();
 const id = await createSale(db, 't1', { storeId: storeA, items: [{ productId: product, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 await printSale(db, 't1', id, op);
 await printSale(db, 't1', id, op);
 const row = await db.prepare('SELECT print_count AS printCount, total FROM sales WHERE id = ?').bind(id).first<{ printCount: number; total: number }>();
 assert.equal(row?.printCount, 2);
 assert.equal(row?.total, 1990);
 assert.equal(await getStock(db, 't1', storeA, product), 9);
 await cancelSale(db, 't1', id, owner);
 assert.equal(await getStock(db, 't1', storeA, product), 10);
 await assert.rejects(() => cancelSale(db, 't1', id, owner), /já cancelada/);
});

test('listSalesForSnapshot junta itens e pagamentos, formando um rótulo de pagamento composto', async () => {
 const { db, storeA, product, op } = await fixture();
 await createSale(db, 't1', { storeId: storeA, items: [{ productId: product, qty: 1 }], customer: 'Cliente', document: '', payments: [{ method: 'Dinheiro', amount: 990 }, { method: 'Pix', amount: 1000 }] }, op);
 const sales = await listSalesForSnapshot(db, 't1');
 assert.equal(sales.length, 1);
 assert.equal(sales[0].payment, 'Dinheiro + Pix');
 assert.equal(sales[0].total, 1990);
 assert.equal(sales[0].items.length, 1);
});
