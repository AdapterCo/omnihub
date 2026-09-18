import assert from 'node:assert/strict';
import test from 'node:test';
import forge from 'node-forge';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale, cancelSale } from '../lib/sales/service.ts';
import { saveFiscalStoreConfig, uploadCertificate, generateNFeForSale, transmitNFe, cancelNFeDocument, getNFeDocumentBySaleId } from '../lib/fiscal/service.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import type { FiscalGateway } from '../lib/fiscal/gateway.ts';

process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';

// §29: "Não executar DELETE. Registrar FiscalDocument → FiscalEvent(CANCELLATION). Se
// cancelamento afetar estoque, caixa ou venda, executar as operações correspondentes de
// maneira controlada, transacional e auditável." Mesma ressalva de verificação SOAP dos
// Marcos 3/DANFE: o mock `FiscalGateway` abaixo é explicitamente identificado como tal,
// já que este ambiente não alcança a SEFAZ real (sem cadeia ICP-Brasil confiável).

const owner = { userId: 'owner-1', displayName: 'Titular', role: 'ADMIN', storeId: null, permissions: permissionsForRole('OWNER') };
const operator = { userId: 'op-1', displayName: 'Operador', role: 'OPERADOR_CAIXA', storeId: null, permissions: permissionsForRole('OPERADOR_CAIXA') };
const gerente = { userId: 'ger-1', displayName: 'Gerente', role: 'GERENTE', storeId: null, permissions: permissionsForRole('GERENTE') };
const plan = { status: 'active', accessUntil: Date.now() + 100000, maxStores: 3 };

function generateTestPfx(passphrase: string, cnpj = '12345678000190') {
 const keys = forge.pki.rsa.generateKeyPair(1024);
 const cert = forge.pki.createCertificate();
 cert.publicKey = keys.publicKey;
 cert.serialNumber = '01';
 cert.validity.notBefore = new Date(Date.now() - 1000 * 60);
 cert.validity.notAfter = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
 const attrs = [{ name: 'commonName', value: `EMPRESA HOMOLOGACAO LTDA:${cnpj}` }, { name: 'countryName', value: 'BR' }];
 cert.setSubject(attrs);
 cert.setIssuer(attrs);
 cert.sign(keys.privateKey, forge.md.sha256.create());
 const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase);
 const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
 return { pfxBuffer: Buffer.from(p12Der, 'binary') };
}

const AUTHORIZED_MOCK: FiscalGateway = {
 async checkServiceStatus() { throw new Error('Not implemented'); },
 async authorizeNFe() {
  return { cStat: '100', xMotivo: 'Autorizado o uso da NF-e', nProt: '135260000000001', dhRecbto: '2026-09-17T02:30:00-03:00', rawXml: '<retEnviNFe/>' };
 },
 async cancelNFe() { throw new Error('Not implemented'); },
 async inutilizeNumbering() { throw new Error('Not implemented'); },
};

const CANCEL_OK_MOCK: FiscalGateway = {
 ...AUTHORIZED_MOCK,
 async cancelNFe(params) {
  assert.ok(params.signedEventXml.includes('<Signature'));
  assert.ok(params.signedEventXml.includes('110111'));
  return { cStat: '135', xMotivo: 'Evento registrado e vinculado a NF-e', nProt: '135260000000002', dhRecbto: '2026-09-17T03:00:00-03:00', rawXml: '<retEvento/>' };
 },
};

const CANCEL_REJECTED_MOCK: FiscalGateway = {
 ...AUTHORIZED_MOCK,
 async cancelNFe() {
  return { cStat: '242', xMotivo: 'Prazo de homologacao do cancelamento superior ao permitido', rawXml: '<retEvento/>' };
 },
};

const CANCEL_ERROR_MOCK: FiscalGateway = {
 ...AUTHORIZED_MOCK,
 async cancelNFe() {
  throw new Error('Falha na comunicação direta com a SEFAZ: timeout');
 },
};

async function fixture() {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'active',9999999999999,3,0)").bind().run();
 const storeId = await createStore(
  db, 't1',
  { name: 'Loja Centro', legalName: 'LOJA CENTRO LTDA', cnpj: '12345678000190', ie: '123456789110', uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' },
  owner,
 );
 await saveFiscalStoreConfig(db, 't1', storeId, { series: 1, crt: '1_SIMPLES_NACIONAL' }, owner);
 const { pfxBuffer } = generateTestPfx('senha123');
 await uploadCertificate(db, 't1', storeId, pfxBuffer, 'senha123', owner);
 const productId = await createProduct(db, 't1', { name: 'Refrigerante 350ml', sku: 'REFRI-350', price: 500, cost: 250, minimum: 5, unit: 'UN', ncm: '22021000', cfop: '5102', origin: '0', taxCode: '102' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId, productId, quantity: 50, userId: owner.userId, reason: 'Estoque inicial' }, owner);
 const op = { ...operator, storeId };
 const ger = { ...gerente, storeId };
 await openSession(db, 't1', storeId, 0, op);
 const saleId = await createSale(db, 't1', { storeId, items: [{ productId, qty: 2 }], customer: 'Cliente Teste', document: '12345678909', payment: 'Dinheiro' }, op);
 await generateNFeForSale(db, 't1', saleId, owner);
 await transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK);
 return { db, storeId, productId, saleId, op, ger };
}

test('cancelNFeDocument bloqueia se não houver NF-e gerada para a venda', async () => {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'active',9999999999999,3,0)").bind().run();
 await assert.rejects(() => cancelNFeDocument(db, 't1', 'venda-inexistente', 'Justificativa de teste com mais de 15 caracteres', owner), /Nenhuma NF-e gerada/);
});

test('cancelNFeDocument bloqueia se a NF-e não estiver autorizada (ex.: ainda GENERATED)', async () => {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'active',9999999999999,3,0)").bind().run();
 const storeId = await createStore(
  db, 't1',
  { name: 'Loja Centro', legalName: 'LOJA CENTRO LTDA', cnpj: '12345678000190', ie: '123456789110', uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' },
  owner,
 );
 await saveFiscalStoreConfig(db, 't1', storeId, { series: 1, crt: '1_SIMPLES_NACIONAL' }, owner);
 const { pfxBuffer } = generateTestPfx('senha123');
 await uploadCertificate(db, 't1', storeId, pfxBuffer, 'senha123', owner);
 const productId = await createProduct(db, 't1', { name: 'Refrigerante 350ml', sku: 'REFRI-350', price: 500, cost: 250, minimum: 5, unit: 'UN', ncm: '22021000', cfop: '5102', origin: '0', taxCode: '102' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId, productId, quantity: 50, userId: owner.userId, reason: 'Estoque inicial' }, owner);
 const op = { ...operator, storeId };
 await openSession(db, 't1', storeId, 0, op);
 const saleId = await createSale(db, 't1', { storeId, items: [{ productId, qty: 2 }], customer: 'Cliente Teste', document: '12345678909', payment: 'Dinheiro' }, op);
 await generateNFeForSale(db, 't1', saleId, owner);
 await assert.rejects(() => cancelNFeDocument(db, 't1', saleId, 'Justificativa de teste com mais de 15 caracteres', owner), /Só é possível cancelar uma NF-e autorizada/);
});

test('cancelNFeDocument exige FISCAL_CANCEL (operador/gerente sem a permissão não pode cancelar)', async () => {
 const { db, saleId, op, ger } = await fixture();
 await assert.rejects(() => cancelNFeDocument(db, 't1', saleId, 'Justificativa de teste com mais de 15 caracteres', op), /não tem permissão/);
 await assert.rejects(() => cancelNFeDocument(db, 't1', saleId, 'Justificativa de teste com mais de 15 caracteres', ger), /não tem permissão/);
});

test('cancelNFeDocument bloqueia justificativa curta (menos de 15 caracteres)', async () => {
 const { db, saleId } = await fixture();
 await assert.rejects(() => cancelNFeDocument(db, 't1', saleId, 'curta', owner, CANCEL_OK_MOCK), /Justificativa/);
});

test('cancelNFeDocument: cStat 135 cancela, grava fiscal_events(CANCELLATION) e marca cancelled_at (§29: nunca DELETE)', async () => {
 const { db, saleId } = await fixture();
 const result = await cancelNFeDocument(db, 't1', saleId, 'Cliente desistiu da compra dentro do prazo legal', owner, CANCEL_OK_MOCK);
 assert.equal(result.status, 'CANCELLED');

 const doc = await getNFeDocumentBySaleId(db, 't1', saleId, owner);
 assert.equal(doc?.status, 'CANCELLED');

 const rows = await db.prepare("SELECT id FROM fiscal_documents WHERE sale_id = ? AND tenant_id = ?").bind(saleId, 't1').all<{ id: string }>();
 assert.equal(rows.results?.length, 1); // nunca DELETE: continua existindo a mesma linha

 const events = await db.prepare("SELECT type, cstat FROM fiscal_events WHERE fiscal_document_id = ?").bind(doc!.id).all<{ type: string; cstat: string }>();
 const cancellation = events.results?.find((e) => e.type === 'CANCELLATION');
 assert.ok(cancellation);
 assert.equal(cancellation?.cstat, '135');
});

test('cancelNFeDocument: cStat de rejeição nunca cancela sozinho (mesmo princípio do §27 aplicado ao cancelamento)', async () => {
 const { db, saleId } = await fixture();
 await assert.rejects(() => cancelNFeDocument(db, 't1', saleId, 'Cliente desistiu da compra dentro do prazo legal', owner, CANCEL_REJECTED_MOCK), /SEFAZ não confirmou o cancelamento/);

 const doc = await getNFeDocumentBySaleId(db, 't1', saleId, owner);
 assert.equal(doc?.status, 'AUTHORIZED');

 const events = await db.prepare("SELECT type FROM fiscal_events WHERE fiscal_document_id = ?").bind(doc!.id).all<{ type: string }>();
 assert.ok(events.results?.some((e) => e.type === 'CANCELLATION_REJECTED'));
});

test('cancelNFeDocument: falha de comunicação não cancela sozinho; documento permanece AUTHORIZED e retentativa funciona', async () => {
 const { db, saleId } = await fixture();
 await assert.rejects(() => cancelNFeDocument(db, 't1', saleId, 'Cliente desistiu da compra dentro do prazo legal', owner, CANCEL_ERROR_MOCK), /Falha na comunicação/);

 const afterFailure = await getNFeDocumentBySaleId(db, 't1', saleId, owner);
 assert.equal(afterFailure?.status, 'AUTHORIZED');

 const retry = await cancelNFeDocument(db, 't1', saleId, 'Cliente desistiu da compra dentro do prazo legal', owner, CANCEL_OK_MOCK);
 assert.equal(retry.status, 'CANCELLED');
});

test('cancelNFeDocument bloqueia cancelamento repetido de NF-e já cancelada', async () => {
 const { db, saleId } = await fixture();
 await cancelNFeDocument(db, 't1', saleId, 'Cliente desistiu da compra dentro do prazo legal', owner, CANCEL_OK_MOCK);
 await assert.rejects(() => cancelNFeDocument(db, 't1', saleId, 'Cliente desistiu da compra dentro do prazo legal', owner, CANCEL_OK_MOCK), /já está cancelada/);
});

test('cancelSale bloqueia cancelamento comercial enquanto a NF-e estiver AUTHORIZED (§29: ordem controlada)', async () => {
 const { db, saleId, ger } = await fixture();
 await assert.rejects(() => cancelSale(db, 't1', saleId, ger), /Cancele a NF-e \(fiscal\) antes de cancelar a venda/);

 // Após cancelar a NF-e, o cancelamento comercial passa a ser permitido e reverte o estoque.
 await cancelNFeDocument(db, 't1', saleId, 'Cliente desistiu da compra dentro do prazo legal', owner, CANCEL_OK_MOCK);
 await cancelSale(db, 't1', saleId, ger);
});

test('dispatchCommand: fiscal.nfe.cancel está ligado ao comando e barra quem não tem FISCAL_CANCEL antes de qualquer tentativa de rede', async () => {
 const { db, saleId, op } = await fixture();
 await assert.rejects(
  () => dispatchCommand(db, 't1', op, plan, { type: 'fiscal.nfe.cancel', saleId, justification: 'Cliente desistiu da compra dentro do prazo legal' }),
  /não tem permissão/,
 );
 const doc = await getNFeDocumentBySaleId(db, 't1', saleId, owner);
 assert.equal(doc?.status, 'AUTHORIZED');
});
