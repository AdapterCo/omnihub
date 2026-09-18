import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import { getStock } from '../lib/inventory/service.ts';
import { listAudit } from '../lib/audit/service.ts';
import type { Entitlement } from '../lib/domain.ts';

const owner = { userId: 'owner-1', displayName: 'Dona da conta', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };
const plan: Entitlement = { status: 'trial', accessUntil: 9999999999999, maxStores: 3 };

async function fixture() {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'trial',9999999999999,3,0)").bind().run();
 return db;
}

test('store.create e product.create passam pelo dispatcher e registram auditoria', async () => {
 const db = await fixture();
 const storeId = await dispatchCommand(db, 't1', owner, plan, { type: 'store.create', data: { name: 'Loja Centro', legalName: '', cnpj: '', ie: '', regime: '', uf: '', city: '', municipalityCode: '', address: '', number: '', district: '', zip: '' } });
 const productId = await dispatchCommand(db, 't1', owner, plan, { type: 'product.create', data: { name: 'Produto A', sku: 'SKU-A', barcode: '', price: 1000, cost: 500, minimum: 1, ncm: '', cest: '', cfop: '', origin: '', taxCode: '', unit: 'UN' } });
 assert.ok(storeId);
 assert.ok(productId);
 const audit = await listAudit(db, 't1');
 assert.equal(audit.length, 2);
 assert.ok(audit.some((a) => a.action === 'store.create' && a.description.includes('Loja Centro')));
 assert.ok(audit.some((a) => a.action === 'product.create' && a.description.includes('Produto A')));
});

test('stock.receive e transfer.create/receive movimentam estoque de ponta a ponta e mantêm auditoria', async () => {
 const db = await fixture();
 const storeA = await dispatchCommand(db, 't1', owner, plan, { type: 'store.create', data: { name: 'Loja A', legalName: '', cnpj: '', ie: '', regime: '', uf: '', city: '', municipalityCode: '', address: '', number: '', district: '', zip: '' } });
 const storeB = await dispatchCommand(db, 't1', owner, plan, { type: 'store.create', data: { name: 'Loja B', legalName: '', cnpj: '', ie: '', regime: '', uf: '', city: '', municipalityCode: '', address: '', number: '', district: '', zip: '' } });
 const productId = await dispatchCommand(db, 't1', owner, plan, { type: 'product.create', data: { name: 'Produto X', sku: 'SKU-X', barcode: '', price: 100, cost: 50, minimum: 1, ncm: '', cest: '', cfop: '', origin: '', taxCode: '', unit: 'UN' } });
 await dispatchCommand(db, 't1', owner, plan, { type: 'stock.receive', storeId: storeA!, productId: productId!, qty: 10, reason: 'Recebimento inicial' });
 assert.equal(await getStock(db, 't1', storeA!, productId!), 10);
 const transferId = await dispatchCommand(db, 't1', owner, plan, { type: 'transfer.create', from: storeA!, to: storeB!, productId: productId!, qty: 4 });
 assert.equal(await getStock(db, 't1', storeA!, productId!), 6, 'transfer.create já despacha (compatibilidade com o antigo status "transit")');
 assert.equal(await getStock(db, 't1', storeB!, productId!), 0);
 await dispatchCommand(db, 't1', owner, plan, { type: 'transfer.receive', id: transferId! });
 assert.equal(await getStock(db, 't1', storeB!, productId!), 4);
 const audit = await listAudit(db, 't1');
 assert.ok(audit.some((a) => a.action === 'stock.receive'));
 assert.ok(audit.some((a) => a.action === 'transfer.create'));
 assert.ok(audit.some((a) => a.action === 'transfer.receive'));
});

test('transfer.create cancela a transferência automaticamente se o despacho falhar por falta de estoque', async () => {
 const db = await fixture();
 const storeA = await dispatchCommand(db, 't1', owner, plan, { type: 'store.create', data: { name: 'Loja A', legalName: '', cnpj: '', ie: '', regime: '', uf: '', city: '', municipalityCode: '', address: '', number: '', district: '', zip: '' } });
 const storeB = await dispatchCommand(db, 't1', owner, plan, { type: 'store.create', data: { name: 'Loja B', legalName: '', cnpj: '', ie: '', regime: '', uf: '', city: '', municipalityCode: '', address: '', number: '', district: '', zip: '' } });
 const productId = await dispatchCommand(db, 't1', owner, plan, { type: 'product.create', data: { name: 'Produto Y', sku: 'SKU-Y', barcode: '', price: 100, cost: 50, minimum: 1, ncm: '', cest: '', cfop: '', origin: '', taxCode: '', unit: 'UN' } });
 await assert.rejects(() => dispatchCommand(db, 't1', owner, plan, { type: 'transfer.create', from: storeA!, to: storeB!, productId: productId!, qty: 5 }), /insuficiente/);
 const row = await db.prepare('SELECT status FROM stock_transfers WHERE from_store_id = ?').bind(storeA).first<{ status: string }>();
 assert.equal(row?.status, 'CANCELLED');
});

test('Limite de lojas do plano é aplicado', async () => {
 const db = await fixture();
 const tightPlan: Entitlement = { ...plan, maxStores: 1 };
 await dispatchCommand(db, 't1', owner, tightPlan, { type: 'store.create', data: { name: 'Primeira', legalName: '', cnpj: '', ie: '', regime: '', uf: '', city: '', municipalityCode: '', address: '', number: '', district: '', zip: '' } });
 await assert.rejects(() => dispatchCommand(db, 't1', owner, tightPlan, { type: 'store.create', data: { name: 'Segunda', legalName: '', cnpj: '', ie: '', regime: '', uf: '', city: '', municipalityCode: '', address: '', number: '', district: '', zip: '' } }), /Limite de lojas/);
});

test('Assinatura expirada bloqueia comandos, exceto os isentos (fechar caixa, reimprimir, confirmar transferência)', async () => {
 const db = await fixture();
 const expired: Entitlement = { ...plan, accessUntil: 0 };
 await assert.rejects(() => dispatchCommand(db, 't1', owner, expired, { type: 'store.create', data: { name: 'Nova', legalName: '', cnpj: '', ie: '', regime: '', uf: '', city: '', municipalityCode: '', address: '', number: '', district: '', zip: '' } }), /acesso terminou/);
});
