import assert from 'node:assert/strict';
import test from 'node:test';
import forge from 'node-forge';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore } from '../lib/catalog/service.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import { listAudit, recordAudit } from '../lib/audit/service.ts';

// §42: AuditLog completo — tenant/loja/usuário/ação/entidade/ID/data-hora já existiam;
// esta entrega (Fase 8) acrescenta IP, correlation ID e informações antes/depois, e exige
// explicitamente "não armazenar segredos nos logs".

process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';

const owner = { userId: 'owner-1', displayName: 'Titular', role: 'ADMIN', storeId: null, permissions: permissionsForRole('OWNER') };
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

async function fixtureTenant() {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'active',9999999999999,3,0)").bind().run();
 return db;
}

test('dispatchCommand propaga ip/correlationId da requisição para o AuditLog', async () => {
 const db = await fixtureTenant();
 const id = await dispatchCommand(db, 't1', owner, plan, { type: 'store.create', data: { name: 'Loja Teste', legalName: 'LOJA TESTE LTDA', cnpj: '', ie: '', regime: 'Simples Nacional', uf: '', city: '', municipalityCode: '', address: '', number: '', district: '', zip: '' } }, Date.now(), { ip: '203.0.113.7', correlationId: 'corr-abc-123' });
 assert.ok(id);

 const entries = await listAudit(db, 't1');
 const entry = entries.find((e) => e.entityId === id);
 assert.ok(entry);
 assert.equal(entry?.ip, '203.0.113.7');
 assert.equal(entry?.correlationId, 'corr-abc-123');
 assert.equal(entry?.entity, 'store');
});

test('AuditLog grava after/before quando aplicável (product.update)', async () => {
 const db = await fixtureTenant();
 const storeId = await createStore(db, 't1', { name: 'Loja Centro', legalName: 'LOJA CENTRO LTDA', cnpj: '12345678000190', ie: '123456789110', uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' }, owner);
 const productId = await dispatchCommand(db, 't1', owner, plan, { type: 'product.create', data: { name: 'Produto A', sku: 'SKU-A', barcode: '', price: 1000, cost: 500, minimum: 1, unit: 'UN', ncm: '', cest: '', cfop: '', origin: '', taxCode: '' } });
 assert.ok(productId);

 await dispatchCommand(db, 't1', owner, plan, { type: 'product.update', id: productId!, data: { name: 'Produto A Renomeado', sku: 'SKU-A', barcode: '', price: 1200, cost: 500, minimum: 1, unit: 'UN', ncm: '', cest: '', cfop: '', origin: '', taxCode: '' } });

 const entries = await listAudit(db, 't1');
 const updateEntry = entries.find((e) => e.entity === 'product' && e.entityId === productId && e.action === 'product.update');
 assert.ok(updateEntry);
 assert.equal((updateEntry?.after as { name: string }).name, 'Produto A Renomeado');
 assert.equal((updateEntry?.before as { name: string })?.name, 'Produto A');
 void storeId;
});

test('AuditLog nunca grava segredos em texto plano (passphrase do certificado, CSC da NFC-e)', async () => {
 const db = await fixtureTenant();
 const storeId = await createStore(db, 't1', { name: 'Loja Centro', legalName: 'LOJA CENTRO LTDA', cnpj: '12345678000190', ie: '123456789110', uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' }, owner);
 await dispatchCommand(db, 't1', owner, plan, { type: 'fiscal.config.save', storeId, series: 1, crt: '1_SIMPLES_NACIONAL' });
 const { pfxBuffer } = generateTestPfx('senha-secreta-123');
 await dispatchCommand(db, 't1', owner, plan, { type: 'fiscal.certificate.upload', storeId, pfxBase64: pfxBuffer.toString('base64'), passphrase: 'senha-secreta-123' });
 await dispatchCommand(db, 't1', owner, plan, { type: 'nfce.config.save', storeId, series: 1, crt: '1_SIMPLES_NACIONAL', cscId: '000001', csc: 'CSC-SUPER-SECRETO', qrCodeBaseUrl: 'https://homologacao.nfce.fazenda.sp.gov.br/qrcode' });

 const rows = await db.prepare("SELECT before_data AS beforeData, after_data AS afterData FROM audit_logs WHERE tenant_id = 't1'").bind().all<{ beforeData: string | null; afterData: string | null }>();
 const allJson = rows.results.map((r) => `${r.beforeData ?? ''}${r.afterData ?? ''}`).join('\n');
 assert.doesNotMatch(allJson, /senha-secreta-123/);
 assert.doesNotMatch(allJson, /CSC-SUPER-SECRETO/);
});

test('recordAudit sanitiza campos de segredo conhecidos mesmo se um chamador futuro esquecer de omiti-los', async () => {
 const db = await fixtureTenant();
 await recordAudit(db, { tenantId: 't1', userId: owner.userId, operator: owner.displayName, action: 'test.secret', description: 'teste', after: { passphrase: 'nao-deveria-vazar', csc: 'nem-este', nome: 'Produto X' } });

 const entries = await listAudit(db, 't1');
 const entry = entries.find((e) => e.action === 'test.secret');
 assert.ok(entry);
 const after = entry?.after as { passphrase: string; csc: string; nome: string };
 assert.equal(after.passphrase, '[REDACTED]');
 assert.equal(after.csc, '[REDACTED]');
 assert.equal(after.nome, 'Produto X');
});
