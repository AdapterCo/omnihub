import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession, closeSession, recordMovement } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale, cancelSale } from '../lib/sales/service.ts';
import { getSalesReport, getCashReport, getFiscalReport } from '../lib/reports/service.ts';

// Fase 8 (§75: "relatórios") — agregações somente-leitura sobre dados já persistidos.

const owner = { userId: 'owner-1', displayName: 'Titular', role: 'ADMIN', storeId: null, permissions: permissionsForRole('OWNER') };
const operator = { userId: 'op-1', displayName: 'Operador', role: 'OPERADOR_CAIXA', storeId: null, permissions: permissionsForRole('OPERADOR_CAIXA') };

async function fixture() {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'active',9999999999999,3,0)").bind().run();
 const storeId = await createStore(db, 't1', { name: 'Loja Centro', legalName: 'LOJA CENTRO LTDA', cnpj: '12345678000190', ie: '123456789110', uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' }, owner);
 const productId = await createProduct(db, 't1', { name: 'Refrigerante 350ml', sku: 'REFRI-350', price: 500, cost: 250, minimum: 5, unit: 'UN' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId, productId, quantity: 50, userId: owner.userId, reason: 'Estoque inicial' }, owner);
 const op = { ...operator, storeId };
 const sessionId = await openSession(db, 't1', storeId, 10000, op);
 await recordMovement(db, 't1', sessionId, 'SUPPLY', 2000, 'Fundo de troco', op);
 await recordMovement(db, 't1', sessionId, 'WITHDRAWAL', 500, 'Depósito bancário', op);
 const saleId1 = await createSale(db, 't1', { storeId, items: [{ productId, qty: 2 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 const saleId2 = await createSale(db, 't1', { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Pix' }, op);
 await cancelSale(db, 't1', saleId2, owner);
 const saleId3 = await createSale(db, 't1', { storeId, items: [{ productId, qty: 3 }], customer: '', document: '', payment: 'Cartão' }, op);
 return { db, storeId, productId, sessionId, op };
}

test('getSalesReport soma apenas vendas COMPLETED, exclui canceladas dos totais mas reporta a contagem de canceladas', async () => {
 const { db } = await fixture();
 const report = await getSalesReport(db, 't1', owner);
 assert.equal(report.totals.count, 2); // saleId1 (2x500=1000) + saleId3 (3x500=1500)
 assert.equal(report.totals.total, 2500);
 assert.equal(report.totals.avgTicket, 1250);
 assert.equal(report.totals.cancelledCount, 1);
 assert.ok(report.periods.length >= 1);
 const paymentMethods = report.payments.map((p) => p.method).sort();
 assert.deepEqual(paymentMethods, ['Cartão', 'Dinheiro']);
});

test('getSalesReport filtra por storeId', async () => {
 const { db, storeId } = await fixture();
 const report = await getSalesReport(db, 't1', owner, { storeId });
 assert.equal(report.totals.count, 2);
 const reportOther = await getSalesReport(db, 't1', owner, { storeId: 'loja-inexistente' });
 assert.equal(reportOther.totals.count, 0);
});

test('getSalesReport exige REPORT_VIEW', async () => {
 const { db } = await fixture();
 const noPermission = { ...operator, permissions: new Set() as unknown as typeof operator.permissions };
 await assert.rejects(() => getSalesReport(db, 't1', noPermission), /não tem permissão/);
});

test('getCashReport soma sangria/suprimento por sessão e calcula totais', async () => {
 const { db, sessionId, op } = await fixture();
 await closeSession(db, 't1', sessionId, 12500, op);

 const report = await getCashReport(db, 't1', owner);
 assert.equal(report.sessions.length, 1);
 const session = report.sessions[0];
 assert.equal(session.supplies, 2000);
 assert.equal(session.withdrawals, 500);
 assert.equal(session.closedAt !== null, true);
 assert.equal(report.totals.sessionCount, 1);
 assert.equal(report.totals.openCount, 0);
 assert.equal(report.totals.totalSupplies, 2000);
 assert.equal(report.totals.totalWithdrawals, 500);
});

test('getCashReport lista sessão em aberto em openCount', async () => {
 const { db } = await fixture();
 const report = await getCashReport(db, 't1', owner);
 assert.equal(report.totals.openCount, 1);
});

test('getFiscalReport agrega fiscal_documents por modelo/status e soma valor autorizado', async () => {
 const { db } = await fixture();
 const report = await getFiscalReport(db, 't1', owner);
 // Sem NF-e/NFC-e geradas neste fixture: nenhuma linha, total autorizado zero.
 assert.deepEqual(report.byModelStatus, []);
 assert.equal(report.totalAuthorizedValue, 0);
 assert.equal(report.pendingTransmissionCount, 0);
});
