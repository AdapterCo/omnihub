import assert from 'node:assert/strict';
import test from 'node:test';
import forge from 'node-forge';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale } from '../lib/sales/service.ts';
import { saveFiscalStoreConfig, uploadCertificate, transmitNFe, cancelNFeDocument, getNFeDocumentBySaleId } from '../lib/fiscal/service.ts';
import { saveNFCeStoreConfig, getNFCeStoreConfig, generateNFCeForSale, getNFCeDanfeData } from '../lib/fiscal/nfce.ts';
import { buildDanfeNfceHtml } from '../lib/fiscal/danfe.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import type { FiscalGateway } from '../lib/fiscal/gateway.ts';

process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';

// Fase 7 (§20): NFC-e Modelo 65. Reaproveita transmitNFe/cancelNFeDocument (genéricos
// quanto ao modelo) — testados aqui apenas quanto à integração com um fiscal_documents
// model='65'. Mesma ressalva de verificação SOAP dos demais marcos fiscais: o mock
// `FiscalGateway` é explicitamente identificado como tal.

const owner = { userId: 'owner-1', displayName: 'Titular', role: 'ADMIN', storeId: null, permissions: permissionsForRole('OWNER') };
const operator = { userId: 'op-1', displayName: 'Operador', role: 'OPERADOR_CAIXA', storeId: null, permissions: permissionsForRole('OPERADOR_CAIXA') };

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
 async authorizeNFe(params) {
  assert.ok(params.signedXml.includes('<qrCode>'));
  return { cStat: '100', xMotivo: 'Autorizado o uso da NF-e', nProt: '135260000000009', dhRecbto: '2026-09-17T05:00:00-03:00', rawXml: '<retEnviNFe/>' };
 },
 async cancelNFe() { throw new Error('Not implemented'); },
 async inutilizeNumbering() { throw new Error('Not implemented'); },
};

async function fixture(withNfceConfig = true) {
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
 if (withNfceConfig) {
  await saveNFCeStoreConfig(db, 't1', storeId, { series: 1, crt: '1_SIMPLES_NACIONAL', cscId: '000001', csc: 'CSC-SECRETO-DE-TESTE', qrCodeBaseUrl: 'https://homologacao.nfce.fazenda.sp.gov.br/qrcode' }, owner);
 }
 const productId = await createProduct(db, 't1', { name: 'Refrigerante 350ml', sku: 'REFRI-350', price: 500, cost: 250, minimum: 5, unit: 'UN', ncm: '22021000', cfop: '5102', origin: '0', taxCode: '102' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId, productId, quantity: 50, userId: owner.userId, reason: 'Estoque inicial' }, owner);
 const op = { ...operator, storeId };
 await openSession(db, 't1', storeId, 0, op);
 const saleId = await createSale(db, 't1', { storeId, items: [{ productId, qty: 2 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 return { db, storeId, productId, saleId, op };
}

test('getNFCeStoreConfig retorna NOT_CONFIGURED antes de qualquer configuração salva', async () => {
 const { db, storeId } = await fixture(false);
 const cfg = await getNFCeStoreConfig(db, 't1', storeId, owner);
 assert.equal(cfg.status, 'NOT_CONFIGURED');
 assert.equal(cfg.cscConfigured, false);
});

test('saveNFCeStoreConfig grava CSC criptografado; getNFCeStoreConfig nunca expõe o segredo', async () => {
 const { db, storeId } = await fixture();
 const cfg = await getNFCeStoreConfig(db, 't1', storeId, owner);
 assert.equal(cfg.status, 'READY');
 assert.equal(cfg.cscId, '000001');
 assert.equal(cfg.cscConfigured, true);
 assert.equal((cfg as unknown as { csc?: string }).csc, undefined);

 const row = await db.prepare("SELECT csc_encrypted AS cscEncrypted FROM fiscal_configurations WHERE tenant_id='t1' AND store_id=? AND model='65'").bind(storeId).first<{ cscEncrypted: string }>();
 assert.ok(row?.cscEncrypted);
 assert.doesNotMatch(row!.cscEncrypted, /CSC-SECRETO-DE-TESTE/);
});

test('generateNFCeForSale bloqueia sem configuração de NFC-e (CSC/QR Code) salva', async () => {
 const { db, saleId } = await fixture(false);
 await assert.rejects(() => generateNFCeForSale(db, 't1', saleId, owner), /Configure a NFC-e/);
});

test('generateNFCeForSale: gera XML modelo 65 com QR Code, sem idDest, valida schema e grava GENERATED', async () => {
 const { db, saleId } = await fixture();
 const doc = await generateNFCeForSale(db, 't1', saleId, owner);
 assert.equal(doc.status, 'GENERATED');
 assert.equal(doc.model, '65');
 assert.ok(doc.rawXml?.includes('<mod>65</mod>'));
 assert.ok(!doc.rawXml?.includes('<idDest>'));
 assert.ok(doc.rawXml?.includes('<qrCode>'));
 assert.ok(doc.rawXml?.includes('<infNFeSupl>'));
});

test('generateNFCeForSale: destinatário é sempre opcional (venda sem CPF/CNPJ não gera <dest>)', async () => {
 const { db, saleId } = await fixture();
 const doc = await generateNFCeForSale(db, 't1', saleId, owner);
 assert.ok(!doc.rawXml?.includes('<dest>'));
});

test('generateNFCeForSale: numeração da NFC-e é independente da numeração de NF-e (sequências separadas por modelo)', async () => {
 const { db, storeId, productId, saleId } = await fixture();
 const doc1 = await generateNFCeForSale(db, 't1', saleId, owner);
 assert.equal(doc1.number, 1);

 const op = { ...operator, storeId };
 const saleId2 = await createSale(db, 't1', { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 const doc2 = await generateNFCeForSale(db, 't1', saleId2, owner);
 assert.equal(doc2.number, 2);
});

test('transmitNFe (genérico) autoriza uma NFC-e (model=65) normalmente', async () => {
 const { db, saleId } = await fixture();
 await generateNFCeForSale(db, 't1', saleId, owner);
 const result = await transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK);
 assert.equal(result.status, 'AUTHORIZED');

 const doc = await getNFeDocumentBySaleId(db, 't1', saleId, owner);
 assert.equal(doc?.status, 'AUTHORIZED');
});

test('getNFCeDanfeData + buildDanfeNfceHtml: NFC-e autorizada gera DANFE NFC-e com QR Code e total corretos', async () => {
 const { db, saleId } = await fixture();
 await generateNFCeForSale(db, 't1', saleId, owner);
 await transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK);

 const data = await getNFCeDanfeData(db, 't1', saleId, owner);
 assert.equal(data.total, 1000); // 2 x R$5,00
 assert.match(data.qrCodeUrl, /^https:\/\/homologacao\.nfce\.fazenda\.sp\.gov\.br\/qrcode\?p=/);

 const html = buildDanfeNfceHtml(data);
 assert.match(html, /DANFE NFC-e/);
 assert.match(html, /SEM VALOR FISCAL — AMBIENTE DE HOMOLOGAÇÃO/);
 assert.match(html, new RegExp(data.qrCodeUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('cancelNFeDocument (genérico) cancela uma NFC-e (model=65) normalmente', async () => {
 const { db, saleId } = await fixture();
 await generateNFCeForSale(db, 't1', saleId, owner);
 await transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK);

 const CANCEL_MOCK: FiscalGateway = { ...AUTHORIZED_MOCK, async cancelNFe() { return { cStat: '135', xMotivo: 'Evento registrado e vinculado a NF-e', nProt: '135260000000010', rawXml: '<retEvento/>' }; } };
 const result = await cancelNFeDocument(db, 't1', saleId, 'Cliente desistiu da compra dentro do prazo legal', owner, CANCEL_MOCK);
 assert.equal(result.status, 'CANCELLED');
});

test('dispatchCommand: nfce.config.save e nfce.generate estão ligados e barram quem não tem permissão', async () => {
 const { db, storeId, saleId, op } = await fixture(false);
 const plan = { status: 'active', accessUntil: Date.now() + 100000, maxStores: 3 };
 await assert.rejects(
  () => dispatchCommand(db, 't1', op, plan, { type: 'nfce.config.save', storeId, series: 1, crt: '1_SIMPLES_NACIONAL', cscId: '000001', csc: 'segredo', qrCodeBaseUrl: 'https://homologacao.nfce.fazenda.sp.gov.br/qrcode' }),
  /não tem permissão/,
 );
 await dispatchCommand(db, 't1', owner, plan, { type: 'nfce.config.save', storeId, series: 1, crt: '1_SIMPLES_NACIONAL', cscId: '000001', csc: 'segredo', qrCodeBaseUrl: 'https://homologacao.nfce.fazenda.sp.gov.br/qrcode' });
 await assert.rejects(
  () => dispatchCommand(db, 't1', op, plan, { type: 'nfce.generate', saleId }),
  /não tem permissão/,
 );
});
