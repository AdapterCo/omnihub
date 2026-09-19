import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { dayKey, isoWithOffset, localParts, offsetString } from '../lib/time.ts';
import { generateAccessKey } from '../lib/fiscal/keys.ts';
import { buildCancellationEventXml } from '../lib/fiscal/events.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { getSalesReport } from '../lib/reports/service.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale } from '../lib/sales/service.ts';

// Regressão do fuso (§61): o servidor roda em UTC, mas dia/mês fiscal e de relatório são os
// de Brasília. Antes, dhEmi trocava só o "Z" por "-03:00" (emissão 3 h no futuro), o AAMM da
// chave usava o relógio do servidor e o relatório agrupava por dia UTC.

// 2026-01-16T02:29:00Z = 15/01/2026 23:29 em Brasília.
const LATE_NIGHT_UTC = Date.UTC(2026, 0, 16, 2, 29, 0);

test('isoWithOffset converte a hora de verdade (não só troca o Z por -03:00)', () => {
 assert.equal(isoWithOffset(LATE_NIGHT_UTC), '2026-01-15T23:29:00-03:00');
 assert.equal(isoWithOffset(Date.UTC(2026, 8, 17, 15, 0, 0)), '2026-09-17T12:00:00-03:00');
 assert.equal(offsetString(LATE_NIGHT_UTC), '-03:00');
 // meia-noite local não pode virar "24:00"
 assert.equal(isoWithOffset(Date.UTC(2026, 8, 17, 3, 0, 0)), '2026-09-17T00:00:00-03:00');
 // o instante representado continua o mesmo
 assert.equal(new Date(isoWithOffset(LATE_NIGHT_UTC)).getTime(), LATE_NIGHT_UTC);
});

test('dayKey e localParts usam o dia de Brasília, também na virada de mês e de ano', () => {
 assert.equal(dayKey(LATE_NIGHT_UTC), '2026-01-15');
 assert.equal(dayKey(Date.UTC(2026, 9, 1, 2, 30, 0)), '2026-09-30');
 assert.deepEqual(localParts(Date.UTC(2027, 0, 1, 1, 0, 0)), { year: 2026, month: 12, day: 31, hour: 22, minute: 0, second: 0 });
});

test('generateAccessKey: AAMM é o mês de Brasília (23h do último dia do mês não vira o mês seguinte)', () => {
 const base = { uf: 'SP', cnpj: '12345678000190', model: '55' as const, series: 1, number: 1, numericCode: '12345678' };
 // 30/09/2026 23:30 em Brasília = 01/10/2026 02:30 UTC
 const lastNight = generateAccessKey({ ...base, emissionDate: new Date(Date.UTC(2026, 9, 1, 2, 30, 0)) });
 assert.equal(lastNight.accessKey.slice(2, 6), '2609');
 const nextDay = generateAccessKey({ ...base, emissionDate: new Date(Date.UTC(2026, 9, 1, 3, 30, 0)) });
 assert.equal(nextDay.accessKey.slice(2, 6), '2610');
});

test('evento de cancelamento: dhEvento é hora local com offset e nunca fica à frente de agora', () => {
 const built = buildCancellationEventXml({
  accessKey: '35260912345678000190550010000000421123456780',
  cOrgao: '35',
  cnpj: '12345678000190',
  environment: 'homologacao',
  protocolNumber: '135260000000001',
  justification: 'Cancelamento de teste por erro de digitação',
  sequenceNumber: 1,
 } as never) as unknown;
 const xml = typeof built === 'string' ? built : JSON.stringify(built);
 const match = /dhEvento>([^<]+)</.exec(xml);
 assert.ok(match, 'dhEvento presente');
 assert.match(match[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00$/);
 assert.ok(new Date(match[1]).getTime() <= Date.now() + 1000, 'dhEvento não pode estar no futuro');
});

test('relatório de vendas agrupa pelo dia de Brasília: venda às 23h29 fica no dia 15, não no 16', async () => {
 const owner = { userId: 'owner-1', displayName: 'Titular', role: 'ADMIN', storeId: null, permissions: permissionsForRole('OWNER') };
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'active',9999999999999,3,0)").bind().run();
 const storeId = await createStore(db, 't1', { name: 'Loja Centro', legalName: 'LOJA CENTRO LTDA', cnpj: '12345678000190', ie: '123456789110', uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' }, owner);
 const productId = await createProduct(db, 't1', { name: 'Refrigerante 350ml', sku: 'REFRI-350', price: 500, cost: 250, minimum: 5, unit: 'UN' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId, productId, quantity: 50, userId: owner.userId, reason: 'Estoque inicial' }, owner);
 const op = { userId: 'op-1', displayName: 'Operador', role: 'OPERADOR_CAIXA', storeId, permissions: permissionsForRole('OPERADOR_CAIXA') };
 await openSession(db, 't1', storeId, 10000, op);
 const late = await createSale(db, 't1', { storeId, items: [{ productId, qty: 2 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 const noon = await createSale(db, 't1', { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 // MOCK de horário (só em teste): fixa o instante das duas vendas para testar a fronteira do dia.
 await db.prepare('UPDATE sales SET created_at = ? WHERE id = ?').bind(LATE_NIGHT_UTC, late).run();
 await db.prepare('UPDATE sales SET created_at = ? WHERE id = ?').bind(Date.UTC(2026, 0, 16, 12, 0, 0), noon).run();
 const report = await getSalesReport(db, 't1', owner);
 const byDay = Object.fromEntries(report.periods.map((p) => [p.day, p.total]));
 assert.deepEqual(byDay, { '2026-01-15': 1000, '2026-01-16': 500 });
});
