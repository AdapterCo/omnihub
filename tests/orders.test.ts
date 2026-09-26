import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { registerAccount, hashPassword } from '../lib/auth/service.ts';
import { loadPermissions } from '../lib/authz/service.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, createProduct, updateProduct, updateStore } from '../lib/catalog/service.ts';
import { openSession, closeSession } from '../lib/cash/service.ts';
import { adjustStock, createTransfer, receiveStock } from '../lib/inventory/service.ts';
import { createSale, cancelSale } from '../lib/sales/service.ts';
import { returnSale } from '../lib/sales/returns.ts';
import { createCustomer } from '../lib/customers/service.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import { registerUnit, removeUnit, createOrder, updateOrder, cancelOrder, completeOrder, addOrderNote, listOrders, listUnits } from '../lib/orders/service.ts';
import type { Actor } from '../lib/domain.ts';

const PASSWORD = 'senha-forte-123';
const plan = { status: 'active', accessUntil: 9_999_999_999_999, maxStores: 3 };
// Datas fixas do teste: "agora" = 2026-09-26 12:00 em São Paulo.
const NOW = Date.UTC(2026, 8, 26, 15, 0, 0);

async function addMember(db: D1Database, tenantId: string, opts: { email: string; roleId: string; legacyRole: string; name: string; storeId?: string | null }) {
    const userId = crypto.randomUUID();
    await db.prepare('INSERT INTO users (id, display_name, email, password_hash, created_at) VALUES (?,?,?,?,?)').bind(userId, opts.name, opts.email, await hashPassword(PASSWORD), 1).run();
    await db.prepare('INSERT INTO memberships (user_id, account_id, role, store_id, display_name) VALUES (?,?,?,?,?)').bind(userId, tenantId, opts.legacyRole, opts.storeId ?? null, opts.name).run();
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
    // Loja de motos (PDV + venda com contrato) e loja de celulares (só locação): mesma conta.
    const motoStore = await createStore(db, tenantId, { name: 'D-MAX', modalities: ['PDV', 'VENDA_CONTRATO'] } as never, owner);
    const cellStore = await createStore(db, tenantId, { name: 'Grupo Cell', modalities: ['LOCACAO'] } as never, owner);
    const moto = await createProduct(db, tenantId, { name: 'Scooter X1', sku: 'MOTO-1', price: 900000, cost: 500000, minimum: 0, unit: 'UN', kind: 'MOTO' } as never, owner);
    const phone = await createProduct(db, tenantId, { name: 'iPhone 13', sku: 'IPH-13', price: 0, cost: 0, minimum: 0, unit: 'UN', kind: 'LOCACAO' } as never, owner);
    const shirt = await createProduct(db, tenantId, { name: 'Capacete', sku: 'CAP-1', price: 15000, cost: 5000, minimum: 0, unit: 'UN' } as never, owner);
    const customerId = await createCustomer(db, tenantId, { name: 'Maria Cliente', document: '52998224725', docType: 'CPF', email: 'maria@exemplo.com', phone: '24999990000', zip: '27260000', address: 'Rua A', number: '10', district: 'Centro', city: 'Volta Redonda', state: 'RJ' }, owner);
    const sellerId = await addMember(db, tenantId, { email: 'online@teste.com', roleId: 'ROLE_VENDEDOR_ONLINE', legacyRole: 'operator', name: 'Vendedor Online' });
    const seller = await actorFor(db, tenantId, sellerId, 'operator', 'Vendedor Online');
    const count = async (storeId: string, productId: string) => Number((await db.prepare('SELECT quantity FROM inventories WHERE store_id = ? AND product_id = ?').bind(storeId, productId).first<{ quantity: number }>())?.quantity ?? 0);
    const unitStatus = async (id: string) => {
        const row = await db.prepare('SELECT status, order_id AS orderId FROM product_units WHERE id = ?').bind(id).first<{ status: string; orderId: string | null }>();
        return row ? { status: row.status, orderId: row.orderId } : null;
    };
    return { db, tenantId, owner, seller, motoStore, cellStore, moto, phone, shirt, customerId, count, unitStatus };
}

test('papel VENDEDOR_ONLINE: permissões do banco batem com a matriz do código', async () => {
    const f = await fixture();
    assert.deepEqual([...f.seller.permissions].sort(), [...permissionsForRole('VENDEDOR_ONLINE')].sort());
    assert.ok(f.seller.permissions.has('ORDER_CREATE') && f.seller.permissions.has('FISCAL_ISSUE') && f.seller.permissions.has('CASH_OPEN'));
    assert.ok(!f.seller.permissions.has('SALE_CANCEL') && !f.seller.permissions.has('USER_VIEW') && !f.seller.permissions.has('STOCK_ADJUST'));
});

test('unidades: IMEI/chassi validados, únicos, campos do contrato obrigatórios e modalidade da loja conferida', async () => {
    const f = await fixture();
    const u1 = await registerUnit(f.db, f.tenantId, { storeId: f.motoStore, productId: f.moto, serial: ' 9bwzzz377vt004251 ', color: 'Preta' }, f.owner, NOW);
    assert.equal(await f.count(f.motoStore, f.moto), 1);
    const [unit] = await listUnits(f.db, f.tenantId);
    assert.equal(unit.serial, '9BWZZZ377VT004251');
    await assert.rejects(() => registerUnit(f.db, f.tenantId, { storeId: f.motoStore, productId: f.moto, serial: '9BWZZZ377VT004251', color: 'Azul' }, f.owner, NOW), /já está cadastrado/);
    await assert.rejects(() => registerUnit(f.db, f.tenantId, { storeId: f.motoStore, productId: f.moto, serial: 'ABC123' }, f.owner, NOW), /cor/);
    await assert.rejects(() => registerUnit(f.db, f.tenantId, { storeId: f.cellStore, productId: f.phone, serial: '12345', color: 'Azul', memory: '128 GB', condition: 'Seminovo' }, f.owner, NOW), /15 dígitos/);
    await assert.rejects(() => registerUnit(f.db, f.tenantId, { storeId: f.cellStore, productId: f.phone, serial: '356938035643809', color: 'Azul' }, f.owner, NOW), /memória, estado do aparelho/);
    // Loja de celulares não vende moto; produto comum não tem unidade.
    await assert.rejects(() => registerUnit(f.db, f.tenantId, { storeId: f.cellStore, productId: f.moto, serial: 'CHASSI-2', color: 'Preta' }, f.owner, NOW), /Venda com contrato/);
    await assert.rejects(() => registerUnit(f.db, f.tenantId, { storeId: f.motoStore, productId: f.shirt, serial: 'X-1', color: 'Preta' }, f.owner, NOW), /comum/);
    // Vendedor online não cadastra estoque.
    await assert.rejects(() => registerUnit(f.db, f.tenantId, { storeId: f.motoStore, productId: f.moto, serial: 'CHASSI-9', color: 'Preta' }, f.seller, NOW), /permissão/);
    // Remover só unidade disponível; baixa o estoque e não apaga.
    await removeUnit(f.db, f.tenantId, u1, f.owner, NOW);
    assert.equal(await f.count(f.motoStore, f.moto), 0);
    assert.equal((await f.unitStatus(u1))?.status, 'REMOVED');
    assert.equal((await listUnits(f.db, f.tenantId)).length, 0);
});

test('produto com unidade não sai pelo PDV, não tem ajuste/transferência avulsa e o tipo não muda com unidades', async () => {
    const f = await fixture();
    await registerUnit(f.db, f.tenantId, { storeId: f.motoStore, productId: f.moto, serial: 'CHASSI-1', color: 'Preta' }, f.owner, NOW);
    await openSession(f.db, f.tenantId, f.motoStore, 0, f.owner, NOW);
    await assert.rejects(() => createSale(f.db, f.tenantId, { storeId: f.motoStore, items: [{ productId: f.moto, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' }, f.owner, NOW), /vendido por pedido/);
    await assert.rejects(() => adjustStock(f.db, { tenantId: f.tenantId, storeId: f.motoStore, productId: f.moto, delta: 1, type: 'MANUAL_ADJUSTMENT', userId: f.owner.userId }, f.owner, NOW), /unidades identificadas/);
    await assert.rejects(() => createTransfer(f.db, { tenantId: f.tenantId, fromStoreId: f.motoStore, toStoreId: f.cellStore, items: [{ productId: f.moto, quantity: 1 }] }, f.owner, NOW), /unidades identificadas/);
    await assert.rejects(() => updateProduct(f.db, f.tenantId, f.moto, { name: 'Scooter X1', sku: 'MOTO-1', price: 900000, cost: 500000, minimum: 0, unit: 'UN', kind: 'COMUM' } as never, f.owner), /tipo não pode ser alterado/);
    // Produto comum com estoque avulso não vira produto com unidade sem zerar o estoque antes.
    await receiveStock(f.db, { tenantId: f.tenantId, storeId: f.motoStore, productId: f.shirt, quantity: 2, userId: f.owner.userId, reason: 'Entrada' }, f.owner, NOW);
    await assert.rejects(() => updateProduct(f.db, f.tenantId, f.shirt, { name: 'Capacete', sku: 'CAP-1', price: 15000, cost: 5000, minimum: 0, unit: 'UN', kind: 'MOTO' } as never, f.owner), /Zere o estoque/);
    // Edição sem o campo kind mantém o tipo atual.
    await updateProduct(f.db, f.tenantId, f.moto, { name: 'Scooter X1 Pro', sku: 'MOTO-1', price: 900000, cost: 500000, minimum: 0, unit: 'UN' } as never, f.owner);
    assert.equal((await f.db.prepare('SELECT kind FROM products WHERE id = ?').bind(f.moto).first<{ kind: string }>())?.kind, 'MOTO');
});

test('modalidade PDV desligada bloqueia o frente de caixa da loja; edição sem modalities mantém as atuais', async () => {
    const f = await fixture();
    await receiveStock(f.db, { tenantId: f.tenantId, storeId: f.cellStore, productId: f.shirt, quantity: 2, userId: f.owner.userId, reason: 'Entrada' }, f.owner, NOW);
    await openSession(f.db, f.tenantId, f.cellStore, 0, f.owner, NOW);
    await assert.rejects(() => createSale(f.db, f.tenantId, { storeId: f.cellStore, items: [{ productId: f.shirt, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' }, f.owner, NOW), /modalidade PDV/);
    await updateStore(f.db, f.tenantId, f.cellStore, { name: 'Grupo Cell Centro' } as never, f.owner);
    assert.equal((await f.db.prepare('SELECT modalities FROM stores WHERE id = ?').bind(f.cellStore).first<{ modalities: string }>())?.modalities, 'LOCACAO');
    await assert.rejects(() => updateStore(f.db, f.tenantId, f.cellStore, { name: 'Grupo Cell', modalities: [] } as never, f.owner));
    await updateStore(f.db, f.tenantId, f.cellStore, { name: 'Grupo Cell', modalities: ['LOCACAO', 'PDV'] } as never, f.owner);
    await createSale(f.db, f.tenantId, { storeId: f.cellStore, items: [{ productId: f.shirt, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' }, f.owner, NOW);
});

test('pedido de venda (moto): reserva a unidade, valida condições, finaliza na loja gerando a venda com entrada + boleto', async () => {
    const f = await fixture();
    const unit = await registerUnit(f.db, f.tenantId, { storeId: f.motoStore, productId: f.moto, serial: 'CHASSI-100', color: 'Vermelha' }, f.owner, NOW);
    const base = { storeId: f.motoStore, type: 'VENDA' as const, customerId: f.customerId, unitId: unit };
    await assert.rejects(() => createOrder(f.db, f.tenantId, { ...base, total: 1000000, installments: 0, downPayment: 500000, downPaymentMethod: 'Pix' }, f.seller, NOW), /valor total/);
    await assert.rejects(() => createOrder(f.db, f.tenantId, { ...base, total: 1000000, installments: 10, downPayment: 200000, downPaymentMethod: 'Pix' }, f.seller, NOW), /primeiro vencimento/);
    await assert.rejects(() => createOrder(f.db, f.tenantId, { ...base, total: 1000000, installments: 10, downPayment: 200000, downPaymentMethod: 'Pix', firstDueDate: '2026-09-01' }, f.seller, NOW), /passado/);
    await assert.rejects(() => createOrder(f.db, f.tenantId, { ...base, total: 1000000, installments: 10, downPayment: 200000, downPaymentMethod: 'Cheque', firstDueDate: '2026-10-26' }, f.seller, NOW), /Dinheiro, Pix ou Cartão/);
    await assert.rejects(() => createOrder(f.db, f.tenantId, { ...base, type: 'LOCACAO', adhesionAmount: 1, monthlyAmount: 1, dueDay: 5, adhesionBilling: 'BOLETO' }, f.seller, NOW), /modalidade de locação/);

    const orderId = await createOrder(f.db, f.tenantId, { ...base, total: 1000000, installments: 10, downPayment: 200000, downPaymentMethod: 'Pix', firstDueDate: '2026-10-26' }, f.seller, NOW);
    assert.deepEqual(await f.unitStatus(unit), { status: 'RESERVED', orderId });
    // A mesma unidade não entra em outro pedido.
    await assert.rejects(() => createOrder(f.db, f.tenantId, { ...base, total: 1000000, installments: 0, downPayment: 1000000, downPaymentMethod: 'Dinheiro' }, f.owner, NOW), /já está reservada/);
    await addOrderNote(f.db, f.tenantId, orderId, 'Cliente vem buscar sábado.', f.seller, NOW);
    let [order] = await listOrders(f.db, f.tenantId, f.seller);
    assert.equal(order.number, 1);
    assert.equal(order.purchaseDate, '2026-09-26');
    assert.equal(order.serial, 'CHASSI-100');
    assert.equal(order.sellerName, 'Vendedor Online');
    assert.equal(order.notes[0].text, 'Cliente vem buscar sábado.');

    // Finalizar exige caixa aberto de quem finaliza.
    await assert.rejects(() => completeOrder(f.db, f.tenantId, orderId, f.seller, NOW), /Abra seu caixa/);
    await openSession(f.db, f.tenantId, f.motoStore, 0, f.seller, NOW);
    const { saleId } = await completeOrder(f.db, f.tenantId, orderId, f.seller, NOW);
    assert.ok(saleId);
    const sale = await f.db.prepare('SELECT total, status, customer FROM sales WHERE id = ?').bind(saleId).first<{ total: number; status: string; customer: string }>();
    assert.deepEqual({ total: Number(sale?.total), status: sale?.status, customer: sale?.customer }, { total: 1000000, status: 'COMPLETED', customer: 'Maria Cliente' });
    const item = await f.db.prepare('SELECT price, qty FROM sale_items WHERE sale_id = ?').bind(saleId).first<{ price: number; qty: number }>();
    assert.equal(Number(item?.price), 1000000, 'preço do pedido (negociado), não o de tabela');
    const pays = (await f.db.prepare('SELECT method, amount FROM sale_payments WHERE sale_id = ? ORDER BY amount').bind(saleId).all<{ method: string; amount: number }>()).results?.map((p) => [p.method, Number(p.amount)]);
    assert.deepEqual(pays, [['Pix', 200000], ['Boleto', 800000]]);
    assert.equal((await f.unitStatus(unit))?.status, 'SOLD');
    assert.equal(await f.count(f.motoStore, f.moto), 0);
    [order] = await listOrders(f.db, f.tenantId, f.seller);
    assert.equal(order.status, 'COMPLETED');
    assert.equal(order.saleId, saleId);
    await assert.rejects(() => completeOrder(f.db, f.tenantId, orderId, f.seller, NOW), /já finalizado/);
    await assert.rejects(() => cancelOrder(f.db, f.tenantId, orderId, 'desistiu da compra', f.seller, NOW), /cancele a venda/);

    // Devolução por item não vale para venda de pedido; cancelar a venda devolve a unidade.
    await assert.rejects(() => returnSale(f.db, f.tenantId, { saleId: saleId as string, items: [{ productId: f.moto, qty: 1, restock: true }], reason: 'Defeito', refundMethod: 'Dinheiro' } as never, f.owner, NOW), /Cancelar venda/);
    await cancelSale(f.db, f.tenantId, saleId as string, f.owner, NOW);
    assert.deepEqual(await f.unitStatus(unit), { status: 'AVAILABLE', orderId: null });
    assert.equal(await f.count(f.motoStore, f.moto), 1);
    [order] = await listOrders(f.db, f.tenantId, f.owner);
    assert.equal(order.status, 'CANCELLED');
});

test('pedido de locação: adesão na loja em dinheiro entra no caixa, equipamento sai do estoque como locado', async () => {
    const f = await fixture();
    const unit = await registerUnit(f.db, f.tenantId, { storeId: f.cellStore, productId: f.phone, serial: '356938035643809', color: 'Azul', memory: '128 GB', condition: 'Seminovo' }, f.owner, NOW);
    const base = { storeId: f.cellStore, type: 'LOCACAO' as const, customerId: f.customerId, unitId: unit };
    await assert.rejects(() => createOrder(f.db, f.tenantId, { ...base, adhesionAmount: 30000, monthlyAmount: 25000, dueDay: 31, adhesionBilling: 'LOJA', adhesionPaymentMethod: 'Dinheiro' }, f.seller, NOW), /1 a 28/);
    await assert.rejects(() => createOrder(f.db, f.tenantId, { ...base, adhesionAmount: 30000, monthlyAmount: 25000, dueDay: 10 } as never, f.seller, NOW), /boleto ou na loja/);
    await assert.rejects(() => createOrder(f.db, f.tenantId, { ...base, adhesionAmount: 30000, monthlyAmount: 25000, dueDay: 10, adhesionBilling: 'LOJA' }, f.seller, NOW), /forma de pagamento da adesão/);
    const orderId = await createOrder(f.db, f.tenantId, { ...base, adhesionAmount: 30000, monthlyAmount: 25000, dueDay: 10, adhesionBilling: 'LOJA', adhesionPaymentMethod: 'Dinheiro' }, f.seller, NOW);
    const session = await openSession(f.db, f.tenantId, f.cellStore, 10000, f.seller, NOW);
    const { saleId } = await completeOrder(f.db, f.tenantId, orderId, f.seller, NOW);
    assert.equal(saleId, null, 'locação não é venda');
    assert.equal((await f.unitStatus(unit))?.status, 'RENTED');
    assert.equal(await f.count(f.cellStore, f.phone), 0);
    const mov = await f.db.prepare("SELECT type, quantity FROM stock_movements WHERE reference_id = ? AND type = 'RENTAL_OUT'").bind(orderId).first<{ type: string; quantity: number }>();
    assert.equal(Number(mov?.quantity), -1);
    // Fechamento do caixa: abertura 100,00 + adesão 300,00 em dinheiro = 400,00 esperado.
    await closeSession(f.db, f.tenantId, session, 40000, f.seller, NOW);
    const closed = await f.db.prepare('SELECT expected_amount AS expected, difference FROM cash_sessions WHERE id = ?').bind(session).first<{ expected: number; difference: number }>();
    assert.deepEqual({ expected: Number(closed?.expected), difference: Number(closed?.difference) }, { expected: 40000, difference: 0 });
});

test('pedido: edição troca unidade liberando a anterior, cancelamento exige motivo e libera a unidade; loja restrita', async () => {
    const f = await fixture();
    const u1 = await registerUnit(f.db, f.tenantId, { storeId: f.motoStore, productId: f.moto, serial: 'CH-1', color: 'Preta' }, f.owner, NOW);
    const u2 = await registerUnit(f.db, f.tenantId, { storeId: f.motoStore, productId: f.moto, serial: 'CH-2', color: 'Branca' }, f.owner, NOW);
    const terms = { total: 900000, installments: 0, downPayment: 900000, downPaymentMethod: 'Cartão' };
    const orderId = await createOrder(f.db, f.tenantId, { storeId: f.motoStore, type: 'VENDA', customerId: f.customerId, unitId: u1, ...terms }, f.seller, NOW);
    await updateOrder(f.db, f.tenantId, orderId, { customerId: f.customerId, unitId: u2, ...terms, total: 850000, downPayment: 850000 }, f.seller, NOW);
    assert.deepEqual(await f.unitStatus(u1), { status: 'AVAILABLE', orderId: null });
    assert.deepEqual(await f.unitStatus(u2), { status: 'RESERVED', orderId });
    assert.equal((await listOrders(f.db, f.tenantId, f.owner))[0].total, 850000);
    await assert.rejects(() => cancelOrder(f.db, f.tenantId, orderId, 'não', f.seller, NOW), /motivo/);
    await cancelOrder(f.db, f.tenantId, orderId, 'Cliente desistiu', f.seller, NOW);
    assert.deepEqual(await f.unitStatus(u2), { status: 'AVAILABLE', orderId: null });
    await assert.rejects(() => updateOrder(f.db, f.tenantId, orderId, { customerId: f.customerId, unitId: u2, ...terms }, f.seller, NOW), /em aberto/);

    // Vendedor online restrito à loja de celulares não mexe em pedido da loja de motos.
    const restrictedId = await addMember(f.db, f.tenantId, { email: 'cell@teste.com', roleId: 'ROLE_VENDEDOR_ONLINE', legacyRole: 'operator', name: 'Vendedora Cell', storeId: f.cellStore });
    const restricted = await actorFor(f.db, f.tenantId, restrictedId, 'operator', 'Vendedora Cell', f.cellStore);
    await assert.rejects(() => createOrder(f.db, f.tenantId, { storeId: f.motoStore, type: 'VENDA', customerId: f.customerId, unitId: u1, ...terms }, restricted, NOW), /outra loja/);
    assert.equal((await listOrders(f.db, f.tenantId, restricted)).length, 0);
});

test('comandos order.* pela API: criação, observação, finalização e auditoria', async () => {
    const f = await fixture();
    const unit = await dispatchCommand(f.db, f.tenantId, f.owner, plan, { type: 'unit.register', storeId: f.motoStore, productId: f.moto, serial: 'CMD-1', color: 'Cinza' }, NOW);
    const orderId = await dispatchCommand(f.db, f.tenantId, f.seller, plan, { type: 'order.create', storeId: f.motoStore, orderType: 'VENDA', customerId: f.customerId, unitId: unit as string, total: 500000, installments: 0, downPayment: 500000, downPaymentMethod: 'Dinheiro' }, NOW);
    await dispatchCommand(f.db, f.tenantId, f.seller, plan, { type: 'order.note', id: orderId as string, text: 'Retirada amanhã' }, NOW);
    await openSession(f.db, f.tenantId, f.motoStore, 0, f.seller, NOW);
    await dispatchCommand(f.db, f.tenantId, f.seller, plan, { type: 'order.complete', id: orderId as string }, NOW);
    const logs = (await f.db.prepare("SELECT description FROM audit_logs WHERE entity = 'order' AND entity_id = ? ORDER BY created_at").bind(orderId).all<{ description: string }>()).results?.map((r) => r.description);
    assert.deepEqual(logs, ['Pedido de venda criado (unidade reservada)', 'Observação adicionada ao pedido', 'Pedido finalizado na loja (venda gerada)']);
});
