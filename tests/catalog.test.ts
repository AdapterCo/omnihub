import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, listStores, createProduct, updateProduct, listProducts } from '../lib/catalog/service.ts';

const owner = { userId: 'owner-1', permissions: permissionsForRole('OWNER') };
const consulta = { userId: 'consulta-1', permissions: permissionsForRole('CONSULTA') };

async function tenant(db: D1Database, id: string) {
 await db.prepare('INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES (?,?,?,0,?,?,3,?)').bind(id, id, '{}', 'trial', 9999999999999, 0).run();
}

test('Isolamento entre tenants: loja criada no tenant A não aparece para o tenant B', async () => {
 const db = createFakeD1();
 await tenant(db, 'tenant-a');
 await tenant(db, 'tenant-b');
 await createStore(db, 'tenant-a', { name: 'Loja da empresa A' }, owner);
 const storesA = await listStores(db, 'tenant-a');
 const storesB = await listStores(db, 'tenant-b');
 assert.equal(storesA.length, 1);
 assert.equal(storesB.length, 0);
});

test('CONSULTA não pode criar loja nem produto', async () => {
 const db = createFakeD1();
 await tenant(db, 'tenant-a');
 await assert.rejects(() => createStore(db, 'tenant-a', { name: 'Loja X' }, consulta), /permissão/);
 await assert.rejects(() => createProduct(db, 'tenant-a', { name: 'Produto X', sku: 'SKU-1', price: 100, cost: 50, minimum: 1, unit: 'UN' }, consulta), /permissão/);
});

test('Produto separa dados comerciais de fiscais e rejeita SKU duplicado no mesmo tenant', async () => {
 const db = createFakeD1();
 await tenant(db, 'tenant-a');
 const id = await createProduct(db, 'tenant-a', { name: 'Produto X', sku: 'SKU-1', price: 1990, cost: 1000, minimum: 2, unit: 'UN', ncm: '12345678' }, owner);
 await assert.rejects(() => createProduct(db, 'tenant-a', { name: 'Outro', sku: 'SKU-1', price: 500, cost: 200, minimum: 1, unit: 'UN' }, owner), /SKU/);
 const fiscal = await db.prepare('SELECT ncm FROM product_fiscal_profiles WHERE product_id = ?').bind(id).first<{ ncm: string }>();
 assert.equal(fiscal?.ncm, '12345678');
 const products = await listProducts(db, 'tenant-a');
 assert.equal(products.length, 1);
 assert.equal(products[0].salePrice, 1990);
});

test('updateProduct atualiza catálogo e perfil fiscal juntos, mas não em outro tenant', async () => {
 const db = createFakeD1();
 await tenant(db, 'tenant-a');
 await tenant(db, 'tenant-b');
 const id = await createProduct(db, 'tenant-a', { name: 'Produto X', sku: 'SKU-1', price: 100, cost: 50, minimum: 1, unit: 'UN' }, owner);
 await assert.rejects(() => updateProduct(db, 'tenant-b', id, { name: 'Produto X', sku: 'SKU-1', price: 200, cost: 50, minimum: 1, unit: 'UN' }, owner), /não encontrado/);
 await updateProduct(db, 'tenant-a', id, { name: 'Produto X renomeado', sku: 'SKU-1', price: 200, cost: 50, minimum: 1, unit: 'UN', cest: '1234567' }, owner);
 const products = await listProducts(db, 'tenant-a');
 assert.equal(products[0].name, 'Produto X renomeado');
 assert.equal(products[0].salePrice, 200);
 const fiscal = await db.prepare('SELECT cest FROM product_fiscal_profiles WHERE product_id = ?').bind(id).first<{ cest: string }>();
 assert.equal(fiscal?.cest, '1234567');
});
