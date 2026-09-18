import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { adjustStock, receiveStock, getStock, createTransfer, approveTransfer, dispatchTransfer, receiveTransfer, cancelTransfer, applySaleStockBatch } from '../lib/inventory/service.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';

const owner = { userId: 'owner-1', permissions: permissionsForRole('OWNER') };
const estoquista = { userId: 'estoquista-1', permissions: permissionsForRole('ESTOQUISTA') };
const consulta = { userId: 'consulta-1', permissions: permissionsForRole('CONSULTA') };

async function fixture() {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'trial',9999999999999,3,0)").bind().run();
 const storeA = await createStore(db, 't1', { name: 'Loja A' }, owner);
 const storeB = await createStore(db, 't1', { name: 'Loja B' }, owner);
 const product = await createProduct(db, 't1', { name: 'Produto X', sku: 'SKU-X', price: 1000, cost: 500, minimum: 1, unit: 'UN' }, owner);
 return { db, storeA, storeB, product };
}

test('receiveStock exige permissão STOCK_ADJUST e cria o saldo inicial', async () => {
 const { db, storeA, product } = await fixture();
 await assert.rejects(() => receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 5, userId: consulta.userId, reason: 'Recebimento' }, consulta), /permissão/);
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 5, userId: estoquista.userId, reason: 'Recebimento' }, estoquista);
 assert.equal(await getStock(db, 't1', storeA, product), 5);
});

test('adjustStock nunca deixa o saldo negativo, mesmo com chamadas concorrentes disputando o último item', async () => {
 const { db, storeA, product } = await fixture();
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 1, userId: owner.userId, reason: 'Estoque inicial' }, owner);
 const attempt = (label: string) => adjustStock(db, { tenantId: 't1', storeId: storeA, productId: product, delta: -1, type: 'SALE', referenceType: 'sale', referenceId: label, userId: owner.userId }, owner);
 const results = await Promise.allSettled([attempt('venda-1'), attempt('venda-2')]);
 const fulfilled = results.filter((r) => r.status === 'fulfilled');
 const rejected = results.filter((r) => r.status === 'rejected');
 assert.equal(fulfilled.length, 1, 'apenas uma das duas vendas deveria conseguir baixar o último item');
 assert.equal(rejected.length, 1);
 assert.equal(await getStock(db, 't1', storeA, product), 0);
});

test('stock_movements registra previous/new quantity corretos após várias movimentações', async () => {
 const { db, storeA, product } = await fixture();
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 10, userId: owner.userId, reason: 'Inicial' }, owner);
 const sale = await adjustStock(db, { tenantId: 't1', storeId: storeA, productId: product, delta: -3, type: 'SALE', userId: owner.userId }, owner);
 assert.deepEqual(sale, { previousQuantity: 10, newQuantity: 7 });
 const rows = await db.prepare('SELECT type, quantity, previous_quantity AS previousQuantity, new_quantity AS newQuantity FROM stock_movements WHERE product_id = ? ORDER BY created_at').bind(product).all<{ type: string; quantity: number; previousQuantity: number; newQuantity: number }>();
 assert.deepEqual(rows.results?.map((r) => ({ ...r })), [
  { type: 'MANUAL_ADJUSTMENT', quantity: 10, previousQuantity: 0, newQuantity: 10 },
  { type: 'SALE', quantity: -3, previousQuantity: 10, newQuantity: 7 },
 ]);
});

test('Transferência: ciclo completo PENDING -> APPROVED -> IN_TRANSIT -> RECEIVED move o estoque só no despacho e no recebimento', async () => {
 const { db, storeA, storeB, product } = await fixture();
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 10, userId: owner.userId, reason: 'Inicial' }, owner);
 const transferId = await createTransfer(db, { tenantId: 't1', fromStoreId: storeA, toStoreId: storeB, items: [{ productId: product, quantity: 4 }] }, owner);
 assert.equal(await getStock(db, 't1', storeA, product), 10, 'PENDING não movimenta estoque');
 await approveTransfer(db, 't1', transferId, owner);
 assert.equal(await getStock(db, 't1', storeA, product), 10, 'APPROVED ainda não movimenta estoque');
 await dispatchTransfer(db, 't1', transferId, owner);
 assert.equal(await getStock(db, 't1', storeA, product), 6, 'IN_TRANSIT decrementa a origem');
 assert.equal(await getStock(db, 't1', storeB, product), 0, 'destino ainda não recebeu');
 await receiveTransfer(db, 't1', transferId, owner);
 assert.equal(await getStock(db, 't1', storeB, product), 4, 'RECEIVED incrementa o destino');
});

test('Transferência não pode ser despachada sem estoque suficiente na origem', async () => {
 const { db, storeA, storeB, product } = await fixture();
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 2, userId: owner.userId, reason: 'Inicial' }, owner);
 const transferId = await createTransfer(db, { tenantId: 't1', fromStoreId: storeA, toStoreId: storeB, items: [{ productId: product, quantity: 5 }] }, owner);
 await approveTransfer(db, 't1', transferId, owner);
 await assert.rejects(() => dispatchTransfer(db, 't1', transferId, owner), /insuficiente/);
});

test('Transferência cancelada antes do despacho não afeta estoque; depois de IN_TRANSIT não pode mais ser cancelada', async () => {
 const { db, storeA, storeB, product } = await fixture();
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 10, userId: owner.userId, reason: 'Inicial' }, owner);
 const transferId = await createTransfer(db, { tenantId: 't1', fromStoreId: storeA, toStoreId: storeB, items: [{ productId: product, quantity: 3 }] }, owner);
 await cancelTransfer(db, 't1', transferId, owner);
 assert.equal(await getStock(db, 't1', storeA, product), 10);
 const other = await createTransfer(db, { tenantId: 't1', fromStoreId: storeA, toStoreId: storeB, items: [{ productId: product, quantity: 3 }] }, owner);
 await approveTransfer(db, 't1', other, owner);
 await dispatchTransfer(db, 't1', other, owner);
 await assert.rejects(() => cancelTransfer(db, 't1', other, owner), /não está em um estado válido/);
});

test('CONSULTA não pode criar transferência (sem STOCK_TRANSFER)', async () => {
 const { db, storeA, storeB, product } = await fixture();
 await assert.rejects(() => createTransfer(db, { tenantId: 't1', fromStoreId: storeA, toStoreId: storeB, items: [{ productId: product, quantity: 1 }] }, consulta), /permissão/);
});

test('applySaleStockBatch: um item sem estoque suficiente reverte o lote inteiro (nenhum item fica baixado parcialmente)', async () => {
 const { db, storeA, product } = await fixture();
 const product2 = await createProduct(db, 't1', { name: 'Produto Y', sku: 'SKU-Y', price: 500, cost: 200, minimum: 1, unit: 'UN' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 5, userId: owner.userId, reason: 'Inicial' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product2, quantity: 1, userId: owner.userId, reason: 'Inicial' }, owner);
 await assert.rejects(() => applySaleStockBatch(db, 't1', [{ storeId: storeA, productId: product, qty: 2 }, { storeId: storeA, productId: product2, qty: 5 }], owner.userId, 'venda-x'), /insuficiente/);
 assert.equal(await getStock(db, 't1', storeA, product), 5, 'primeiro item não deveria ter sido baixado, já que o segundo falhou');
 assert.equal(await getStock(db, 't1', storeA, product2), 1);
});

test('applySaleStockBatch com reverse:true devolve o estoque (compensação de venda cujo registro em JSON falhou)', async () => {
 const { db, storeA, product } = await fixture();
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 10, userId: owner.userId, reason: 'Inicial' }, owner);
 await applySaleStockBatch(db, 't1', [{ storeId: storeA, productId: product, qty: 3 }], owner.userId, 'venda-y');
 assert.equal(await getStock(db, 't1', storeA, product), 7);
 await applySaleStockBatch(db, 't1', [{ storeId: storeA, productId: product, qty: 3 }], owner.userId, 'venda-y', { reverse: true });
 assert.equal(await getStock(db, 't1', storeA, product), 10);
 const movements = await db.prepare("SELECT type FROM stock_movements WHERE product_id = ? ORDER BY created_at").bind(product).all<{ type: string }>();
 assert.deepEqual(movements.results?.map((m) => m.type), ['MANUAL_ADJUSTMENT', 'SALE', 'SALE_CANCEL']);
});
