import assert from 'node:assert/strict';
import test from 'node:test';
import forge from 'node-forge';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale } from '../lib/sales/service.ts';
import { saveFiscalStoreConfig, uploadCertificate, generateNFeForSale, transmitNFe, getNFeDocumentBySaleId } from '../lib/fiscal/service.ts';
import type { FiscalGateway } from '../lib/fiscal/gateway.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';

// getMasterKey() em lib/fiscal/certificate.ts exige FISCAL_SECRET_KEY no ambiente (sem
// fallback fixo no código, §23) — o teste simula o que um deploy real precisa configurar.
process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';

// Marco 3 (Fase 5): assinatura + transmissão. Como o ambiente deste teste NÃO tem acesso à
// cadeia de certificação ICP-Brasil nem ao serviço real da SEFAZ (ver conversa: o Portal
// Nacional devolveu um loop de redirecionamento e o endpoint real exige TLS com CA ICP-
// Brasil), estes testes usam um `FiscalGateway` MOCK, explicitamente identificado como tal
// (§79 permite mocks somente em teste, claramente identificados). Isso valida a integração
// (assinatura → transmissão → interpretação de cStat → persistência), não a comunicação
// real contra a SEFAZ de homologação — essa só pode ser validada com certificado A1
// verdadeiro num ambiente com a cadeia ICP-Brasil confiável.

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
 await openSession(db, 't1', storeId, 0, op);
 const saleId = await createSale(db, 't1', { storeId, items: [{ productId, qty: 2 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 await generateNFeForSale(db, 't1', saleId, owner);
 return { db, storeId, productId, saleId, op };
}

const AUTHORIZED_MOCK = (nProt = '135260000000001'): FiscalGateway => ({
 async checkServiceStatus() { throw new Error('Not implemented'); },
 async authorizeNFe(params) {
  assert.ok(params.signedXml.includes('<Signature'));
  return { cStat: '100', xMotivo: 'Autorizado o uso da NF-e', nProt, dhRecbto: '2026-09-17T02:30:00-03:00', rawXml: `<retEnviNFe><protNFe><infProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo><nProt>${nProt}</nProt></infProt></protNFe></retEnviNFe>` };
 },
 async cancelNFe() { throw new Error('Not implemented'); },
 async inutilizeNumbering() { throw new Error('Not implemented'); },
});

const REJECTED_MOCK: FiscalGateway = {
 async checkServiceStatus() { throw new Error('Not implemented'); },
 async authorizeNFe() {
  return { cStat: '539', xMotivo: 'Rejeicao: Duplicidade de NF-e', rawXml: '<retEnviNFe><protNFe><infProt><cStat>539</cStat><xMotivo>Rejeicao: Duplicidade de NF-e</xMotivo></infProt></protNFe></retEnviNFe>' };
 },
 async cancelNFe() { throw new Error('Not implemented'); },
 async inutilizeNumbering() { throw new Error('Not implemented'); },
};

const NETWORK_ERROR_MOCK: FiscalGateway = {
 async checkServiceStatus() { throw new Error('Not implemented'); },
 async authorizeNFe() {
  throw new Error('Falha na comunicação direta com a SEFAZ: timeout');
 },
 async cancelNFe() { throw new Error('Not implemented'); },
 async inutilizeNumbering() { throw new Error('Not implemented'); },
};

test('transmitNFe: cStat 100 autoriza, grava protocolo, assinatura e evento', async () => {
 const { db, saleId } = await fixture();
 const result = await transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK());
 assert.equal(result.status, 'AUTHORIZED');
 assert.equal(result.protocolNumber, '135260000000001');
 assert.ok(result.signedXml?.includes('<Signature'));

 const doc = await getNFeDocumentBySaleId(db, 't1', saleId, owner);
 assert.equal(doc?.status, 'AUTHORIZED');
 assert.ok(doc?.authorizedAt);

 const events = await db.prepare("SELECT type, cstat, protocol_number AS nProt FROM fiscal_events WHERE fiscal_document_id = ?").bind(doc!.id).all<{ type: string; cstat: string; nProt: string }>();
 assert.equal(events.results?.length, 1);
 assert.equal(events.results?.[0].type, 'AUTHORIZATION');
 assert.equal(events.results?.[0].cstat, '100');
});

test('transmitNFe: cStat de rejeição nunca vira autorização automática (§27)', async () => {
 const { db, saleId } = await fixture();
 const result = await transmitNFe(db, 't1', saleId, owner, REJECTED_MOCK);
 assert.equal(result.status, 'REJECTED');
 assert.equal(result.protocolNumber, null);

 const doc = await getNFeDocumentBySaleId(db, 't1', saleId, owner);
 assert.equal(doc?.status, 'REJECTED');
 assert.equal(doc?.authorizedAt, null);

 const events = await db.prepare("SELECT type FROM fiscal_events WHERE fiscal_document_id = ?").bind(doc!.id).all<{ type: string }>();
 assert.equal(events.results?.[0].type, 'REJECTION');
});

test('transmitNFe: falha de comunicação não autoriza sozinho; documento fica retomável (SIGNED) e pode ser tentado de novo', async () => {
 const { db, saleId } = await fixture();
 await assert.rejects(() => transmitNFe(db, 't1', saleId, owner, NETWORK_ERROR_MOCK), /Falha na comunicação/);

 const afterFailure = await getNFeDocumentBySaleId(db, 't1', saleId, owner);
 assert.equal(afterFailure?.status, 'SIGNED');

 const errorEvents = await db.prepare("SELECT type FROM fiscal_events WHERE fiscal_document_id = ?").bind(afterFailure!.id).all<{ type: string }>();
 assert.equal(errorEvents.results?.[0].type, 'TRANSMISSION_ERROR');

 // Retentativa com sucesso deve autorizar normalmente (nunca duplica o documento — mesma linha em fiscal_documents)
 const retry = await transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK());
 assert.equal(retry.status, 'AUTHORIZED');
 assert.equal(retry.id, afterFailure!.id);
});

test('transmitNFe: bloqueia retransmissão de documento já autorizado', async () => {
 const { db, saleId } = await fixture();
 await transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK());
 await assert.rejects(() => transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK()), /já está autorizada/);
});

test('transmitNFe: bloqueia se não houver NF-e gerada para a venda', async () => {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'active',9999999999999,3,0)").bind().run();
 await assert.rejects(() => transmitNFe(db, 't1', 'venda-inexistente', owner, AUTHORIZED_MOCK()), /Nenhuma NF-e gerada/);
});

test('transmitNFe: operador sem FISCAL_ISSUE não pode transmitir', async () => {
 const { db, saleId, op } = await fixture();
 await assert.rejects(() => transmitNFe(db, 't1', saleId, op, AUTHORIZED_MOCK()), /não tem permissão/);
});

test('dispatchCommand: fiscal.nfe.transmit está ligado ao comando e barra quem não tem FISCAL_ISSUE antes de qualquer tentativa de rede', async () => {
 const { db, saleId, op } = await fixture();
 // dispatchCommand usa o SefazDirectGateway real por padrão (não aceita mock injetado);
 // este teste evita rede real validando só o roteamento e a checagem de permissão, que
 // acontecem antes de qualquer chamada ao gateway — igual ao padrão já usado para
 // fiscal.connectivity.test em tests/fiscal.connectivity.test.ts.
 await assert.rejects(() => dispatchCommand(db, 't1', op, plan, { type: 'fiscal.nfe.transmit', saleId }), /não tem permissão/);
 const doc = await getNFeDocumentBySaleId(db, 't1', saleId, owner);
 assert.equal(doc?.status, 'GENERATED');
});
