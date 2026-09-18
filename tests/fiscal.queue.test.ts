import assert from 'node:assert/strict';
import test from 'node:test';
import forge from 'node-forge';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale } from '../lib/sales/service.ts';
import { saveFiscalStoreConfig, uploadCertificate, generateNFeForSale, getNFeDocumentBySaleId, transmitNFe } from '../lib/fiscal/service.ts';
import { enqueueFiscalJob, runFiscalJobWorker, getFiscalJobsSummary } from '../lib/fiscal/queue.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import type { FiscalGateway } from '../lib/fiscal/gateway.ts';

process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';

// §41: fila baseada em D1 (decisão do usuário) para reprocessar transmissão/cancelamento
// fiscal com retry/backoff/dead-letter/idempotência, sem depender de Cloudflare Queues
// (não configurado no projeto). Mock `FiscalGateway` explicitamente identificado como tal.

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

const AUTHORIZED_MOCK: FiscalGateway = {
 async checkServiceStatus() { throw new Error('Not implemented'); },
 async authorizeNFe() { return { cStat: '100', xMotivo: 'Autorizado o uso da NF-e', nProt: '135260000000099', dhRecbto: '2026-09-18T10:00:00-03:00', rawXml: '<retEnviNFe/>' }; },
 async cancelNFe() { throw new Error('Not implemented'); },
 async inutilizeNumbering() { throw new Error('Not implemented'); },
};

const NETWORK_ERROR_MOCK: FiscalGateway = {
 ...AUTHORIZED_MOCK,
 async authorizeNFe() { throw new Error('Falha na comunicação direta com a SEFAZ: timeout'); },
};

async function fixture() {
 const db = createFakeD1();
 await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant','{}',0,'active',9999999999999,3,0)").bind().run();
 // runFiscalJobWorker recarrega o ator via lib/authz/service.ts's loadPermissions, que
 // depende de um vínculo real em `memberships` (ou `user_tenant_roles`) — diferente das
 // demais funções de serviço, que recebem `permissions` já resolvidas no objeto Actor.
 await db.prepare("INSERT INTO memberships (user_id, account_id, role, store_id, display_name) VALUES (?, 't1', 'admin', NULL, ?)").bind(owner.userId, owner.displayName).run();
 const storeId = await createStore(db, 't1', { name: 'Loja Centro', legalName: 'LOJA CENTRO LTDA', cnpj: '12345678000190', ie: '123456789110', uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' }, owner);
 await saveFiscalStoreConfig(db, 't1', storeId, { series: 1, crt: '1_SIMPLES_NACIONAL' }, owner);
 const { pfxBuffer } = generateTestPfx('senha123');
 await uploadCertificate(db, 't1', storeId, pfxBuffer, 'senha123', owner);
 const productId = await createProduct(db, 't1', { name: 'Refrigerante 350ml', sku: 'REFRI-350', price: 500, cost: 250, minimum: 5, unit: 'UN', ncm: '22021000', cfop: '5102', origin: '0', taxCode: '102' }, owner);
 await receiveStock(db, { tenantId: 't1', storeId, productId, quantity: 50, userId: owner.userId, reason: 'Estoque inicial' }, owner);
 const op = { ...operator, storeId };
 await openSession(db, 't1', storeId, 0, op);
 const saleId = await createSale(db, 't1', { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' }, op);
 await generateNFeForSale(db, 't1', saleId, owner);
 return { db, storeId, saleId };
}

test('enqueueFiscalJob é idempotente: duas chamadas com a mesma chave não criam dois jobs pendentes', async () => {
 const { db, saleId } = await fixture();
 const id1 = await enqueueFiscalJob(db, 't1', { jobType: 'TRANSMIT_NFE', saleId, userId: owner.userId });
 const id2 = await enqueueFiscalJob(db, 't1', { jobType: 'TRANSMIT_NFE', saleId, userId: owner.userId });
 assert.equal(id1, id2);

 const rows = await db.prepare("SELECT id FROM fiscal_jobs WHERE tenant_id='t1' AND sale_id=?").bind(saleId).all<{ id: string }>();
 assert.equal(rows.results?.length, 1);
});

test('runFiscalJobWorker processa um job pendente e autoriza a NF-e (reaproveita transmitNFe)', async () => {
 const { db, saleId } = await fixture();
 await enqueueFiscalJob(db, 't1', { jobType: 'TRANSMIT_NFE', saleId, userId: owner.userId });

 const result = await runFiscalJobWorker(db, AUTHORIZED_MOCK);
 assert.equal(result.processed, 1);
 assert.equal(result.succeeded, 1);
 assert.equal(result.failed, 0);

 const doc = await getNFeDocumentBySaleId(db, 't1', saleId, owner);
 assert.equal(doc?.status, 'AUTHORIZED');

 const jobRow = await db.prepare("SELECT status FROM fiscal_jobs WHERE tenant_id='t1' AND sale_id=?").bind(saleId).first<{ status: string }>();
 assert.equal(jobRow?.status, 'SUCCEEDED');
});

test('runFiscalJobWorker: falha de rede agenda retry com backoff (nunca cai direto em dead-letter)', async () => {
 const { db, saleId } = await fixture();
 await enqueueFiscalJob(db, 't1', { jobType: 'TRANSMIT_NFE', saleId, userId: owner.userId, maxAttempts: 3 });

 const before = Date.now();
 const result = await runFiscalJobWorker(db, NETWORK_ERROR_MOCK, {}, before);
 assert.equal(result.failed, 1);
 assert.equal(result.deadLettered, 0);

 const jobRow = await db.prepare("SELECT status, attempts, next_attempt_at AS nextAttemptAt FROM fiscal_jobs WHERE tenant_id='t1' AND sale_id=?").bind(saleId).first<{ status: string; attempts: number; nextAttemptAt: number }>();
 assert.equal(jobRow?.status, 'PENDING');
 assert.equal(jobRow?.attempts, 1);
 assert.ok(jobRow!.nextAttemptAt > before);
});

test('runFiscalJobWorker: esgotadas as tentativas, vai para DEAD_LETTER', async () => {
 const { db, saleId } = await fixture();
 await enqueueFiscalJob(db, 't1', { jobType: 'TRANSMIT_NFE', saleId, userId: owner.userId, maxAttempts: 1 });

 const result = await runFiscalJobWorker(db, NETWORK_ERROR_MOCK);
 assert.equal(result.deadLettered, 1);

 const jobRow = await db.prepare("SELECT status FROM fiscal_jobs WHERE tenant_id='t1' AND sale_id=?").bind(saleId).first<{ status: string }>();
 assert.equal(jobRow?.status, 'DEAD_LETTER');
});

test('runFiscalJobWorker: se o job falha mas o documento já está no estado desejado, marca sucesso (nunca duplica)', async () => {
 const { db, saleId } = await fixture();
 // Autoriza primeiro por fora da fila, simulando que uma tentativa anterior teve sucesso
 // mas o job não foi marcado a tempo (ex.: crash entre a chamada e o UPDATE).
 await transmitNFe(db, 't1', saleId, owner, AUTHORIZED_MOCK);

 await enqueueFiscalJob(db, 't1', { jobType: 'TRANSMIT_NFE', saleId, userId: owner.userId, maxAttempts: 1 });
 const result = await runFiscalJobWorker(db, NETWORK_ERROR_MOCK);
 assert.equal(result.succeeded, 1);
 assert.equal(result.deadLettered, 0);
});

test('dispatchCommand: fiscal.nfe.retry enfileira e fiscal.jobs.process processa; ambos exigem permissão', async () => {
 const { db, saleId, storeId } = await fixture();
 await assert.rejects(() => dispatchCommand(db, 't1', operator, plan, { type: 'fiscal.nfe.retry', saleId, jobType: 'TRANSMIT_NFE' }), /não tem permissão/);
 await assert.rejects(() => dispatchCommand(db, 't1', { ...operator, storeId }, plan, { type: 'fiscal.jobs.process' }), /não tem permissão/);

 const jobId = await dispatchCommand(db, 't1', owner, plan, { type: 'fiscal.nfe.retry', saleId, jobType: 'TRANSMIT_NFE' });
 assert.ok(jobId);

 const resultJson = await dispatchCommand(db, 't1', owner, plan, { type: 'fiscal.jobs.process' });
 const result = JSON.parse(resultJson!);
 assert.equal(result.processed, 1);
});

test('getFiscalJobsSummary retorna contagem por status e dead-letters recentes', async () => {
 const { db, saleId } = await fixture();
 await enqueueFiscalJob(db, 't1', { jobType: 'TRANSMIT_NFE', saleId, userId: owner.userId, maxAttempts: 1 });
 await runFiscalJobWorker(db, NETWORK_ERROR_MOCK);

 const summary = await getFiscalJobsSummary(db, 't1', owner);
 assert.equal(summary.byStatus.DEAD_LETTER, 1);
 assert.equal(summary.deadLetters.length, 1);
 assert.equal(summary.deadLetters[0].saleId, saleId);
});
