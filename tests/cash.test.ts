import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore } from '../lib/catalog/service.ts';
import { openSession, closeSession, recordMovement, findOpenSessionForUser } from '../lib/cash/service.ts';
import { createSale } from '../lib/sales/service.ts';
import { createProduct } from '../lib/catalog/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';

const owner = { userId: 'owner-1', displayName: 'Dona', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };
const operator = { userId: 'operator-1', displayName: 'Operador', role: 'operator', storeId: '', permissions: permissionsForRole('OPERADOR_CAIXA') };

async function fixture() {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'trial',9999999999999,3,0)").bind().run();
 const storeA = await createStore(db, 't1', { name: 'Loja A' }, owner);
 return { db, storeA };
}

test('Abertura de caixa cria o terminal padrão automaticamente e impede duas aberturas simultâneas do mesmo operador', async () => {
 const { db, storeA } = await fixture();
 const op = { ...operator, storeId: storeA };
 const id = await openSession(db, 't1', storeA, 1000, op);
 assert.ok(id);
 const register = await db.prepare('SELECT COUNT(*) AS n FROM cash_registers WHERE store_id = ?').bind(storeA).first<{ n: number }>();
 assert.equal(register?.n, 1);
 await assert.rejects(() => openSession(db, 't1', storeA, 500, op), /já tem um caixa aberto/);
});

test('Operador não pode abrir caixa de outra loja', async () => {
 const { db, storeA } = await fixture();
 const storeB = await createStore(db, 't1', { name: 'Loja B' }, owner);
 const op = { ...operator, storeId: storeA };
 await assert.rejects(() => openSession(db, 't1', storeB, 0, op), /outra loja/);
});

test('Sangria e suprimento entram no cálculo do valor esperado no fechamento', async () => {
 const { db, storeA } = await fixture();
 const op = { ...operator, storeId: storeA };
 const sessionId = await openSession(db, 't1', storeA, 10000, op);
 await recordMovement(db, 't1', sessionId, 'SUPPLY', 5000, 'Troco adicional', op);
 await recordMovement(db, 't1', sessionId, 'WITHDRAWAL', 3000, 'Retirada para o cofre', op);
 await closeSession(db, 't1', sessionId, 12000, op);
 const row = await db.prepare('SELECT expected_amount AS expected, difference FROM cash_sessions WHERE id = ?').bind(sessionId).first<{ expected: number; difference: number }>();
 assert.equal(row?.expected, 12000); // 10000 + 5000 - 3000
 assert.equal(row?.difference, 0);
});

test('Fechamento soma somente pagamentos em dinheiro das vendas da sessão', async () => {
 const { db, storeA } = await fixture();
 const op = { ...operator, storeId: storeA };
 const product = await createProduct(db, 't1', { name: 'Produto', sku: 'SKU-1', price: 1000, cost: 500, minimum: 1, unit: 'UN' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId: storeA, productId: product, quantity: 10, userId: owner.userId, reason: 'Inicial' }, owner);
 const sessionId = await openSession(db, 't1', storeA, 0, op);
 await createSale(db, 't1', { storeId: storeA, items: [{ productId: product, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 await createSale(db, 't1', { storeId: storeA, items: [{ productId: product, qty: 1 }], customer: '', document: '', payment: 'Pix' }, op);
 await closeSession(db, 't1', sessionId, 1000, op);
 const row = await db.prepare('SELECT expected_amount AS expected FROM cash_sessions WHERE id = ?').bind(sessionId).first<{ expected: number }>();
 assert.equal(row?.expected, 1000, 'só a venda em Dinheiro entra no esperado, não a de Pix');
});

test('Não é possível movimentar (sangria/suprimento) um caixa já fechado', async () => {
 const { db, storeA } = await fixture();
 const op = { ...operator, storeId: storeA };
 const sessionId = await openSession(db, 't1', storeA, 0, op);
 await closeSession(db, 't1', sessionId, 0, op);
 await assert.rejects(() => recordMovement(db, 't1', sessionId, 'SUPPLY', 100, 'Tarde demais', op), /já fechado/);
});

test('findOpenSessionForUser não encontra sessão de outro usuário nem de outra loja', async () => {
 const { db, storeA } = await fixture();
 const op = { ...operator, storeId: storeA };
 await openSession(db, 't1', storeA, 0, op);
 assert.ok(await findOpenSessionForUser(db, 't1', storeA, op.userId));
 assert.equal(await findOpenSessionForUser(db, 't1', storeA, 'outro-usuario'), null);
});
