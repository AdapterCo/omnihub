import assert from 'node:assert/strict';
import test from 'node:test';
import forge from 'node-forge';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale } from '../lib/sales/service.ts';
import { saveFiscalStoreConfig, uploadCertificate, generateNFeForSale, transmitNFe, getDanfeData } from '../lib/fiscal/service.ts';
import { buildDanfeHtml } from '../lib/fiscal/danfe.ts';
import type { FiscalGateway } from '../lib/fiscal/gateway.ts';

process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';

// §22: DANFE só pode ser gerado a partir de dados fiscais já autorizados. Estes testes
// usam o mesmo `FiscalGateway` mock explicitamente identificado já usado em
// tests/fiscal.transmission.test.ts, pelo mesmo motivo (sem acesso à SEFAZ real neste
// ambiente).

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
 async authorizeNFe() {
  return { cStat: '100', xMotivo: 'Autorizado o uso da NF-e', nProt: '135260000000001', dhRecbto: '2026-09-17T02:30:00-03:00', rawXml: '<retEnviNFe/>' };
 },
 async cancelNFe() { throw new Error('Not implemented'); },
 async inutilizeNumbering() { throw new Error('Not implemented'); },
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
 await openSession(db, 't1', storeId, 0, op);
 const saleId = await createSale(db, 't1', { storeId, items: [{ productId, qty: 2 }], customer: 'Cliente Teste', document: '12345678909', payment: 'Dinheiro' }, op);
 await generateNFeForSale(db, 't1', saleId, owner);
 return { db, storeId, productId, saleId, op };
}

test('getDanfeData bloqueia se não houver NF-e gerada para a venda', async () => {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'active',9999999999999,3,0)").bind().run();
 await assert.rejects(() => getDanfeData(db, 't1', 'venda-inexistente', owner), /Nenhuma NF-e gerada/);
});

test('getDanfeData bloqueia se a NF-e ainda não estiver autorizada (§22: só a partir de dados válidos/autorizados)', async () => {
 const { db, saleId } = await fixture();
 await assert.rejects(() => getDanfeData(db, 't1', saleId, owner), /só pode ser exibido para NF-e autorizada/);
});

test('getDanfeData exige FISCAL_VIEW', async () => {
 const { db, saleId, op } = await fixture();
 await transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK);
 await assert.rejects(() => getDanfeData(db, 't1', saleId, op), /não tem permissão/);
});

test('getDanfeData + buildDanfeHtml: NF-e autorizada gera DANFE com chave, protocolo, itens e total corretos; sem QR Code (exclusivo de NFC-e)', async () => {
 const { db, saleId } = await fixture();
 await transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK);

 const data = await getDanfeData(db, 't1', saleId, owner);
 assert.equal(data.protocolNumber, '135260000000001');
 assert.equal(data.series, 1);
 assert.equal(data.items.length, 1);
 assert.equal(data.items[0].qty, 2);
 assert.equal(data.total, 1000); // 2 x R$5,00

 const html = buildDanfeHtml(data);
 assert.match(html, /DANFE/);
 assert.match(html, /SEM VALOR FISCAL — AMBIENTE DE HOMOLOGAÇÃO/);
 assert.match(html, /135260000000001/);
 assert.match(html, /REFRI-350/);
 assert.match(html, /Cliente Teste/);
 assert.doesNotMatch(html, /QR ?Code/i);
});

test('getDanfeData: isolamento entre tenants', async () => {
 const { db, saleId } = await fixture();
 await transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK);
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t2','Outro','{}',0,'active',9999999999999,3,0)").bind().run();
 await assert.rejects(() => getDanfeData(db, 't2', saleId, owner), /Nenhuma NF-e gerada/);
});
