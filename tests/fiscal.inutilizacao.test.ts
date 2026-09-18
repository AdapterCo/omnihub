import assert from 'node:assert/strict';
import test from 'node:test';
import forge from 'node-forge';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale } from '../lib/sales/service.ts';
import { saveFiscalStoreConfig, uploadCertificate, generateNFeForSale, inutilizeFiscalNumbering } from '../lib/fiscal/service.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import type { FiscalGateway } from '../lib/fiscal/gateway.ts';

process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';

// §25: "Considerar tratamento de inutilização quando aplicável." Mesma ressalva de
// verificação SOAP dos demais marcos fiscais: o mock `FiscalGateway` abaixo é
// explicitamente identificado como tal, já que este ambiente não alcança a SEFAZ real.

const owner = { userId: 'owner-1', displayName: 'Titular', role: 'ADMIN', storeId: null, permissions: permissionsForRole('OWNER') };
const operator = { userId: 'op-1', displayName: 'Operador', role: 'OPERADOR_CAIXA', storeId: null, permissions: permissionsForRole('OPERADOR_CAIXA') };
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

const noopGateway = {
 async checkServiceStatus() { throw new Error('Not implemented'); },
 async authorizeNFe() { throw new Error('Not implemented'); },
 async cancelNFe() { throw new Error('Not implemented'); },
};

const CONFIRMED_MOCK: FiscalGateway = {
 ...noopGateway,
 async inutilizeNumbering(params) {
  assert.ok(params.signedInutilizacaoXml.includes('<Signature'));
  assert.ok(params.signedInutilizacaoXml.includes('INUTILIZAR'));
  return { cStat: '102', xMotivo: 'Inutilização de número homologada', nProt: '135260000000003', dhRecbto: '2026-09-17T04:00:00-03:00', rawXml: '<retInutNFe/>' };
 },
};

const REJECTED_MOCK: FiscalGateway = {
 ...noopGateway,
 async inutilizeNumbering() {
  return { cStat: '563', xMotivo: 'Numero de NF ja utilizado com sequencial diferente', rawXml: '<retInutNFe/>' };
 },
};

const ERROR_MOCK: FiscalGateway = {
 ...noopGateway,
 async inutilizeNumbering() {
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
 return { db, storeId };
}

test('inutilizeFiscalNumbering bloqueia se a loja não existir', async () => {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'active',9999999999999,3,0)").bind().run();
 await assert.rejects(() => inutilizeFiscalNumbering(db, 't1', 'loja-inexistente', 1, 10, 10, 'Numero pulado por falha antes da emissao', owner), /Loja não encontrada/);
});

test('inutilizeFiscalNumbering exige FISCAL_CANCEL', async () => {
 const { db, storeId } = await fixture();
 await assert.rejects(() => inutilizeFiscalNumbering(db, 't1', storeId, 1, 10, 10, 'Numero pulado por falha antes da emissao', operator), /não tem permissão/);
});

test('inutilizeFiscalNumbering bloqueia justificativa curta', async () => {
 const { db, storeId } = await fixture();
 await assert.rejects(() => inutilizeFiscalNumbering(db, 't1', storeId, 1, 10, 10, 'curta', owner, CONFIRMED_MOCK), /Justificativa/);
});

test('inutilizeFiscalNumbering bloqueia faixa que já contém número emitido (nunca inutiliza número usado)', async () => {
 const { db, storeId } = await fixture();
 const productId = await createProduct(db, 't1', { name: 'Refrigerante 350ml', sku: 'REFRI-350', price: 500, cost: 250, minimum: 5, unit: 'UN', ncm: '22021000', cfop: '5102', origin: '0', taxCode: '102' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId, productId, quantity: 50, userId: owner.userId, reason: 'Estoque inicial' }, owner);
 const op = { ...operator, storeId };
 await openSession(db, 't1', storeId, 0, op);
 const saleId = await createSale(db, 't1', { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 const doc = await generateNFeForSale(db, 't1', saleId, owner);

 await assert.rejects(() => inutilizeFiscalNumbering(db, 't1', storeId, 1, doc.number, doc.number, 'Numero pulado por falha antes da emissao', owner, CONFIRMED_MOCK), /já foi utilizado em um documento fiscal/);
});

test('inutilizeFiscalNumbering: cStat 102 confirma e grava fiscal_inutilizations (nunca DELETE, sempre auditável)', async () => {
 const { db, storeId } = await fixture();
 const result = await inutilizeFiscalNumbering(db, 't1', storeId, 1, 10, 12, 'Numeros pulados por falha de sistema antes da emissao real', owner, CONFIRMED_MOCK);
 assert.equal(result.status, 'CONFIRMED');
 assert.equal(result.protocolNumber, '135260000000003');

 const row = await db.prepare("SELECT status, cstat, protocol_number AS protocolNumber FROM fiscal_inutilizations WHERE id = ?").bind(result.id).first<{ status: string; cstat: string; protocolNumber: string }>();
 assert.equal(row?.status, 'CONFIRMED');
 assert.equal(row?.cstat, '102');
});

test('inutilizeFiscalNumbering: cStat de rejeição nunca confirma sozinho', async () => {
 const { db, storeId } = await fixture();
 await assert.rejects(() => inutilizeFiscalNumbering(db, 't1', storeId, 1, 20, 20, 'Numero pulado por falha antes da emissao', owner, REJECTED_MOCK), /SEFAZ não confirmou a inutilização/);

 const row = await db.prepare("SELECT status FROM fiscal_inutilizations WHERE tenant_id = 't1' AND number_start = 20").bind().first<{ status: string }>();
 assert.equal(row?.status, 'REJECTED');
});

test('inutilizeFiscalNumbering: falha de comunicação não confirma sozinho', async () => {
 const { db, storeId } = await fixture();
 await assert.rejects(() => inutilizeFiscalNumbering(db, 't1', storeId, 1, 30, 30, 'Numero pulado por falha antes da emissao', owner, ERROR_MOCK), /Falha na comunicação/);

 const row = await db.prepare("SELECT status FROM fiscal_inutilizations WHERE tenant_id = 't1' AND number_start = 30").bind().first<{ status: string }>();
 assert.equal(row?.status, 'ERROR');
});

test('inutilizeFiscalNumbering bloqueia repetir faixa já confirmada', async () => {
 const { db, storeId } = await fixture();
 await inutilizeFiscalNumbering(db, 't1', storeId, 1, 40, 45, 'Numeros pulados por falha de sistema antes da emissao real', owner, CONFIRMED_MOCK);
 await assert.rejects(() => inutilizeFiscalNumbering(db, 't1', storeId, 1, 42, 43, 'Numeros pulados por falha de sistema antes da emissao real', owner, CONFIRMED_MOCK), /já está inutilizada/);
});

test('dispatchCommand: fiscal.nfe.inutilizar está ligado ao comando e barra quem não tem FISCAL_CANCEL', async () => {
 const { db, storeId } = await fixture();
 await assert.rejects(
  () => dispatchCommand(db, 't1', operator, plan, { type: 'fiscal.nfe.inutilizar', storeId, series: 1, numberStart: 50, numberEnd: 50, justification: 'Numero pulado por falha antes da emissao' }),
  /não tem permissão/,
 );
 const row = await db.prepare("SELECT id FROM fiscal_inutilizations WHERE tenant_id = 't1' AND number_start = 50").bind().first<{ id: string }>();
 assert.equal(row, null);
});
