import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { registerAccount, hashPassword } from '../lib/auth/service.ts';
import { loadPermissions } from '../lib/authz/service.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { createCustomer } from '../lib/customers/service.ts';
import { registerUnit, createOrder, updateOrder, cancelOrder } from '../lib/orders/service.ts';
import { generateContract, listContracts } from '../lib/contracts/service.ts';
import { listOrderDocuments, readDocument } from '../lib/documents/service.ts';
import { createLocalStorage } from '../lib/storage/index.ts';
import { verifyAdapterSignWebhook, type SignFetch } from '../lib/signature/adapterSign.ts';
import {
    saveSignatureConfig, getSignatureConfigSummary, sendContractForSignature, newSigningLink, cancelSignature,
    receiveAdapterSignWebhook, processAdapterSignEvent, reconcileSignatures, syncContract,
} from '../lib/signature/service.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import type { Actor } from '../lib/domain.ts';

process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';
const PASSWORD = 'senha-forte-123';
const API_KEY = 'as_test_0000000000_MOCK'; // MOCK: chave fictícia, nunca real
const WEBHOOK_SECRET = 'whsec_teste_somente_0123456789'; // MOCK
const plan = { status: 'active', accessUntil: 9_999_999_999_999, maxStores: 3 };
const NOW = Date.UTC(2026, 8, 26, 15, 0, 0);
const BASE = 'https://sign.exemplo.test/api/v1';

/**
 * MOCK do Adapter Sign (só em teste): implementa em memória o comportamento documentado em
 * docs/api.md e integracao-sistema-vendas.md — from-template idempotente por externalRef (mesma
 * referência ativa devolve o mesmo envelope com replayed=true), loja assinada no envio, link do
 * cliente só na resposta, GET do envelope, link novo, cancelamento e PDFs final/evidências após
 * COMPLETED. O teste controla status e injeta falhas. Nenhuma chamada sai para a internet.
 */
function createAdapterSignMock() {
    type Env = { id: string; status: string; externalRef: string; validationCode: string; docId: string; signers: { id: string; role: string; name: string; email: string; status: string; cpf?: string; phone?: string; externalId?: string }[]; finalAvailable: boolean; template: string };
    const envelopes = new Map<string, Env>();
    const calls: { method: string; path: string; data?: Record<string, unknown>; fileSize?: number; auth?: string }[] = [];
    let seq = 0;
    let nextFailure: { status: number; code?: string; message?: string } | 'network' | null = null;
    const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });
    const pdf = (label: string) => { const bytes = new TextEncoder().encode(`%PDF-1.7\n% ${label}\n`); return { status: 200, text: async () => '', arrayBuffer: async () => bytes.buffer as ArrayBuffer }; };
    const fetch: SignFetch = async (url, init) => {
        const path = url.replace(BASE, '');
        const entry: (typeof calls)[number] = { method: init.method, path, auth: init.headers.Authorization };
        if (init.body instanceof FormData) {
            entry.data = JSON.parse(String(init.body.get('data')));
            entry.fileSize = (init.body.get('file') as Blob).size;
        }
        calls.push(entry);
        if (nextFailure) {
            const f = nextFailure;
            nextFailure = null;
            if (f === 'network') throw new Error('ECONNRESET (simulado)');
            return json(f.status, { error: { code: f.code ?? 'INTERNAL', message: f.message ?? 'falha simulada', request_id: 'req-mock' } });
        }
        if (init.headers.Authorization !== `Bearer ${API_KEY}`) return json(401, { error: { code: 'UNAUTHENTICATED', message: 'invalid key', request_id: 'r' } });
        if (init.method === 'POST' && path === '/envelopes/from-template') {
            const data = entry.data as { template: string; externalRef: string; signers: Env['signers'] };
            const existing = [...envelopes.values()].find((e) => e.externalRef === data.externalRef && !['CANCELLED', 'EXPIRED', 'DECLINED'].includes(e.status));
            const env = existing ?? (() => {
                const id = `env-${++seq}`;
                const created: Env = { id, status: 'PARTIALLY_SIGNED', externalRef: data.externalRef, validationCode: `ADP-MOCK-${seq}`, docId: `edoc-${seq}`, template: data.template, finalAvailable: false,
                    signers: data.signers.map((s, i) => ({ ...s, id: `${id}-s${i}`, status: s.role === 'loja' ? 'SIGNED' : 'INVITED' })) };
                envelopes.set(id, created);
                return created;
            })();
            return json(201, { id: env.id, status: env.status, externalRef: env.externalRef, validationCode: env.validationCode, replayed: !!existing, documents: [{ id: env.docId, filename: 'c.pdf', originalSha256: 'x' }],
                signers: env.signers.map((s) => ({ id: s.id, role: s.role, name: s.name, status: s.status, signingUrl: s.role === 'cliente' && s.status !== 'SIGNED' ? `https://sign.exemplo.test/sign/TOKEN-${env.id}-${calls.length}` : null, signingUrlExpiresAt: s.role === 'cliente' ? '2026-10-10T00:00:00Z' : null })) });
        }
        const m = path.match(/^\/envelopes\/([^/]+)(?:\/(.*))?$/);
        const env = m ? envelopes.get(decodeURIComponent(m[1])) : undefined;
        if (!env) return json(404, { error: { code: 'ENVELOPE_NOT_FOUND', message: 'não encontrado', request_id: 'r' } });
        const rest = m?.[2] ?? '';
        if (init.method === 'GET' && rest === '') return json(200, { id: env.id, status: env.status, externalRef: env.externalRef, validationCode: env.validationCode, completedAt: null, documents: [{ id: env.docId, finalAvailable: env.finalAvailable, finalSha256: null }], signers: env.signers.map((s) => ({ id: s.id, roleKey: s.role, status: s.status, signedAt: null, declinedAt: null })) });
        if (init.method === 'POST' && /^signers\/[^/]+\/link$/.test(rest)) {
            if (!['ACTIVE', 'PARTIALLY_SIGNED'].includes(env.status)) return json(409, { error: { code: 'ENVELOPE_NOT_ACTIVE', message: 'inativo', request_id: 'r' } });
            return json(200, { signerId: rest.split('/')[1], signingUrl: `https://sign.exemplo.test/sign/NOVO-${calls.length}`, expiresAt: '2026-10-11T00:00:00Z' });
        }
        if (init.method === 'POST' && rest === 'cancel') {
            if (env.status === 'COMPLETED') return json(409, { error: { code: 'INVALID_ENVELOPE_TRANSITION', message: 'concluído', request_id: 'r' } });
            env.status = 'CANCELLED';
            return json(200, { ok: true });
        }
        if (init.method === 'GET' && /^documents\/[^/]+\/final$/.test(rest)) return env.finalAvailable ? pdf(`final ${env.id}`) : json(409, { error: { code: 'NOT_READY', message: 'x', request_id: 'r' } });
        if (init.method === 'GET' && rest === 'evidence') return env.status === 'COMPLETED' ? pdf(`evidencias ${env.id}`) : json(409, { error: { code: 'NOT_READY', message: 'x', request_id: 'r' } });
        return json(404, { error: { code: 'NOT_FOUND', message: path, request_id: 'r' } });
    };
    return {
        fetch, calls, envelopes,
        complete: (id: string) => { const e = envelopes.get(id)!; e.status = 'COMPLETED'; e.finalAvailable = true; e.signers.forEach((s) => { s.status = 'SIGNED'; }); },
        clientSigned: (id: string) => { const e = envelopes.get(id)!; e.signers.forEach((s) => { s.status = 'SIGNED'; }); },
        set: (id: string, status: string) => { envelopes.get(id)!.status = status; },
        failNext: (f: typeof nextFailure) => { nextFailure = f; },
    };
}

function signWebhook(body: string, eventId: string, tsSeconds: number, secret = WEBHOOK_SECRET) {
    return 'v1=' + createHmac('sha256', secret).update(`${tsSeconds}.${eventId}.${body}`).digest('hex');
}

async function addMember(db: D1Database, tenantId: string, opts: { email: string | null; roleId: string; name: string }) {
    const userId = crypto.randomUUID();
    await db.prepare('INSERT INTO users (id, display_name, email, password_hash, created_at) VALUES (?,?,?,?,?)').bind(userId, opts.name, opts.email, await hashPassword(PASSWORD), 1).run();
    await db.prepare('INSERT INTO memberships (user_id, account_id, role, store_id, display_name) VALUES (?,?,?,NULL,?)').bind(userId, tenantId, 'operator', opts.name).run();
    await db.prepare('INSERT INTO user_tenant_roles (id, user_id, tenant_id, role_id) VALUES (?,?,?,?)').bind(crypto.randomUUID(), userId, tenantId, opts.roleId).run();
    return userId;
}
async function actorFor(db: D1Database, tenantId: string, userId: string, legacyRole: string, name: string): Promise<Actor> {
    return { userId, displayName: name, role: legacyRole, storeId: null, permissions: await loadPermissions(db, userId, tenantId, legacyRole) };
}

async function fixture(options: { configure?: boolean } = {}) {
    const db = createFakeD1();
    const storage = createLocalStorage(await mkdtemp(join(tmpdir(), 'omnihub-sign-')));
    const mock = createAdapterSignMock();
    const deps = { fetch: mock.fetch, storage, baseUrl: BASE };
    const reg = await registerAccount(db, { accountName: 'Grupo Teste', displayName: 'Dona Ana', email: 'ana@teste.com', password: PASSWORD });
    const tenantId = reg.accountId;
    const owner = await actorFor(db, tenantId, reg.userId, 'admin', 'Dona Ana');
    const store = await createStore(db, tenantId, { name: 'D-MAX', cnpj: '65715457000128', modalities: ['VENDA_CONTRATO'] } as never, owner);
    const moto = await createProduct(db, tenantId, { name: 'Scooter X1', sku: 'M1', price: 900000, cost: 1, minimum: 0, unit: 'UN', kind: 'MOTO' } as never, owner);
    const customerId = await createCustomer(db, tenantId, { name: 'Maria Cliente', document: '52998224725', docType: 'CPF', email: 'maria@exemplo.com', phone: '(24) 99999-1234', zip: '27260000', address: 'Rua A', number: '10', district: 'Centro', city: 'Volta Redonda', state: 'RJ' }, owner);
    const sellerId = await addMember(db, tenantId, { email: 'vendedor@loja.com', roleId: 'ROLE_VENDEDOR_ONLINE', name: 'Carlos Vendedor' });
    const seller = await actorFor(db, tenantId, sellerId, 'operator', 'Carlos Vendedor');
    if (options.configure !== false) await saveSignatureConfig(db, tenantId, store, { apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, motoTemplate: 'contrato-moto', locacaoTemplate: '' }, owner, NOW);
    let serial = 0;
    const newContract = async () => {
        const unit = await registerUnit(db, tenantId, { storeId: store, productId: moto, serial: `CH-${++serial}`, color: 'Preta' }, owner, NOW);
        const orderId = await createOrder(db, tenantId, { storeId: store, type: 'VENDA', customerId, unitId: unit, total: 900000, purchaseDate: '2026-09-26', installments: 0, downPayment: 900000, downPaymentMethod: 'Pix' }, seller, NOW);
        const c = await generateContract(db, storage, tenantId, orderId, seller, NOW);
        return { orderId, unit, contractId: c.contractId, externalRef: c.externalRef };
    };
    const contract = async (id: string) => (await listContracts(db, tenantId, owner)).find((c) => c.id === id)!;
    return { db, storage, mock, deps, tenantId, owner, seller, store, customerId, newContract, contract };
}

test('verificação HMAC do webhook: assinatura, janela de 300 s e event id', () => {
    const body = '{"id":"evt1"}';
    const ts = Math.floor(NOW / 1000);
    const sig = signWebhook(body, 'evt1', ts);
    assert.ok(verifyAdapterSignWebhook({ secret: WEBHOOK_SECRET, signature: sig, timestamp: String(ts), eventId: 'evt1', rawBody: body, nowMs: NOW }));
    assert.ok(!verifyAdapterSignWebhook({ secret: WEBHOOK_SECRET, signature: sig, timestamp: String(ts), eventId: 'evt1', rawBody: body + ' ', nowMs: NOW }), 'corpo alterado');
    assert.ok(!verifyAdapterSignWebhook({ secret: WEBHOOK_SECRET, signature: sig, timestamp: String(ts), eventId: 'evt2', rawBody: body, nowMs: NOW }), 'outro evento');
    assert.ok(!verifyAdapterSignWebhook({ secret: WEBHOOK_SECRET, signature: sig, timestamp: String(ts), eventId: 'evt1', rawBody: body, nowMs: NOW + 301_000 }), 'fora da janela');
    assert.ok(!verifyAdapterSignWebhook({ secret: 'outro', signature: sig, timestamp: String(ts), eventId: 'evt1', rawBody: body, nowMs: NOW }), 'segredo errado');
});

test('configuração: API key obrigatória na criação, modelo validado, segredos nunca devolvidos, em branco mantém', async () => {
    const f = await fixture({ configure: false });
    await assert.rejects(() => saveSignatureConfig(f.db, f.tenantId, f.store, { motoTemplate: 'contrato-moto' }, f.owner, NOW), /API key/);
    await assert.rejects(() => saveSignatureConfig(f.db, f.tenantId, f.store, { apiKey: API_KEY, motoTemplate: 'Contrato Moto!' }, f.owner, NOW), /Identificador do modelo de moto/);
    await assert.rejects(() => saveSignatureConfig(f.db, f.tenantId, f.store, { apiKey: API_KEY }, f.seller, NOW), /permissão/);
    await dispatchCommand(f.db, f.tenantId, f.owner, plan, { type: 'signature.config.save', storeId: f.store, apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, motoTemplate: 'contrato-moto' }, NOW);
    const summary = await getSignatureConfigSummary(f.db, f.tenantId, f.store);
    assert.equal(summary.configured, true);
    assert.equal(summary.hasWebhookSecret, true);
    assert.match(summary.webhookPath!, /^\/api\/signature\/adapter-sign\/webhook\/[a-f0-9]{48}$/);
    assert.ok(!JSON.stringify(summary).includes(API_KEY) && !JSON.stringify(summary).includes(WEBHOOK_SECRET));
    const row = await f.db.prepare('SELECT api_key_enc AS a, webhook_secret_enc AS w FROM signature_configs').bind().first<{ a: string; w: string }>();
    assert.ok(!row!.a.includes(API_KEY) && !row!.w.includes(WEBHOOK_SECRET), 'cifrados no banco');
    const audit = await f.db.prepare("SELECT after_data AS a FROM audit_logs WHERE entity = 'signature_config'").bind().first<{ a: string }>();
    assert.ok(!audit!.a.includes(API_KEY) && !audit!.a.includes(WEBHOOK_SECRET), 'auditoria sem segredos');
    await saveSignatureConfig(f.db, f.tenantId, f.store, { apiKey: '', webhookSecret: '', motoTemplate: 'contrato-moto-2' }, f.owner, NOW);
    assert.equal(((await f.db.prepare('SELECT api_key_enc AS a FROM signature_configs').bind().first<{ a: string }>())!.a), row!.a, 'API key em branco mantém a salva');
});

test('envio: loja assina em nome do vendedor logado, cliente com CPF e WhatsApp, link devolvido e não gravado', async () => {
    const f = await fixture();
    const c = await f.newContract();
    const sent = await sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, f.deps, NOW);
    assert.match(sent.signingUrl!, /^https:\/\/sign\.exemplo\.test\/sign\//);
    assert.equal(sent.replayed, false);
    const call = f.mock.calls.find((x) => x.path === '/envelopes/from-template')!;
    assert.equal(call.auth, `Bearer ${API_KEY}`);
    assert.ok(call.fileSize! > 1000, 'PDF enviado');
    assert.deepEqual(call.data, {
        template: 'contrato-moto',
        externalRef: c.externalRef,
        title: 'Contrato de venda #1 - Maria Cliente',
        signers: [
            { role: 'loja', name: 'Carlos Vendedor', email: 'vendedor@loja.com', externalId: f.seller.userId },
            { role: 'cliente', name: 'Maria Cliente', email: 'maria@exemplo.com', cpf: '529.982.247-25', phone: '+5524999991234' },
        ],
    });
    const contract = await f.contract(c.contractId);
    assert.equal(contract.status, 'SENT');
    assert.equal(contract.validationCode, 'ADP-MOCK-1');
    assert.equal(contract.sentByName, 'Carlos Vendedor');
    const dump = JSON.stringify(await f.db.prepare('SELECT * FROM contracts').bind().all());
    assert.ok(!dump.includes('/sign/TOKEN'), 'signingUrl nunca é gravado');
    // Pedido travado enquanto aguarda assinatura.
    await assert.rejects(() => cancelOrder(f.db, f.tenantId, c.orderId, 'desistiu da compra', f.seller, NOW), /contrato enviado para assinatura/);
    // Link novo para o cliente.
    const link = await newSigningLink(f.db, f.tenantId, c.contractId, f.seller, f.deps);
    assert.match(link.signingUrl, /NOVO/);
    await assert.rejects(() => sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, f.deps, NOW), /já foi enviado/);
});

test('envio bloqueia sem configuração, sem modelo, sem e-mail do vendedor; recusa definitiva volta para corrigir', async () => {
    const f = await fixture({ configure: false });
    const c = await f.newContract();
    await assert.rejects(() => sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, f.deps, NOW), /não configurada/);
    await saveSignatureConfig(f.db, f.tenantId, f.store, { apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, locacaoTemplate: 'contrato-locacao' }, f.owner, NOW);
    await assert.rejects(() => sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, f.deps, NOW), /identificador do modelo de moto/);
    await saveSignatureConfig(f.db, f.tenantId, f.store, { motoTemplate: 'contrato-moto', locacaoTemplate: '' }, f.owner, NOW);
    const noEmailId = await addMember(f.db, f.tenantId, { email: null, roleId: 'ROLE_VENDEDOR_ONLINE', name: 'Sem Email' });
    const noEmail = await actorFor(f.db, f.tenantId, noEmailId, 'operator', 'Sem Email');
    await assert.rejects(() => sendContractForSignature(f.db, f.tenantId, c.contractId, noEmail, f.deps, NOW), /não tem e-mail/);
    f.mock.failNext({ status: 422, code: 'COMPANY_SIGNATURE_NOT_AUTHORIZED', message: 'x' });
    await assert.rejects(() => sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, f.deps, NOW), /proprietário precisa aceitar/);
    let contract = await f.contract(c.contractId);
    assert.equal(contract.status, 'GENERATED', 'nada foi criado: volta para reenviar depois de corrigir');
    assert.match(contract.lastError, /Assinatura da empresa/);
    f.mock.failNext({ status: 422, code: 'TEMPLATE_ANCHORS_MISMATCH' });
    await assert.rejects(() => sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, f.deps, NOW), /marcadores/);
    await sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, f.deps, NOW);
    contract = await f.contract(c.contractId);
    assert.equal(contract.status, 'SENT');
    assert.equal(contract.lastError, '');
});

test('instabilidade: fica SENDING (pedido travado) e a retentativa usa o mesmo externalRef sem duplicar', async () => {
    const f = await fixture();
    const c = await f.newContract();
    f.mock.failNext('network');
    await assert.rejects(() => sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, f.deps, NOW), /repetido automaticamente/);
    assert.equal((await f.contract(c.contractId)).status, 'SENDING');
    await assert.rejects(() => updateOrder(f.db, f.tenantId, c.orderId, { customerId: f.customerId, unitId: c.unit, total: 800000, purchaseDate: '2026-09-26', installments: 0, downPayment: 800000, downPaymentMethod: 'Pix' }, f.seller, NOW), /contrato enviado/);
    f.mock.failNext({ status: 503, code: 'INTERNAL' });
    await assert.rejects(() => sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, f.deps, NOW), /Instabilidade/);
    // Worker retoma com o vendedor original (sem actor).
    const result = await reconcileSignatures(f.db, f.deps, NOW + 120_000);
    assert.equal(result.resent, 1);
    assert.equal((await f.contract(c.contractId)).status, 'SENT');
    const creations = f.mock.calls.filter((x) => x.path === '/envelopes/from-template');
    assert.ok(creations.every((x) => x.data!.externalRef === c.externalRef && (x.data!.signers as { externalId?: string }[])[0].externalId === f.seller.userId));
    assert.equal(f.mock.envelopes.size, 1, 'um único envelope, apesar das retentativas');
});

test('webhook: HMAC, deduplicação, consulta ao Adapter Sign e download do contrato assinado + evidências', async () => {
    const f = await fixture();
    const c = await f.newContract();
    await sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, f.deps, NOW);
    const key = (await getSignatureConfigSummary(f.db, f.tenantId, f.store)).webhookPath!.split('/').pop()!;
    const envId = [...f.mock.envelopes.keys()][0];
    const ts = Math.floor(NOW / 1000);
    const event = (id: string, type: string) => JSON.stringify({ id, type, created_at: '2026-09-26T15:00:00Z', organization_id: 'org', data: { envelope: { id: envId, status: 'COMPLETED', external_ref: c.externalRef, documents: [] }, signer: null } });

    assert.equal((await receiveAdapterSignWebhook(f.db, '0'.repeat(48), { signature: 'x', timestamp: String(ts), eventId: 'e', rawBody: '{}' }, NOW)).status, 404);
    const body1 = event('evt-1', 'signer.signed');
    assert.equal((await receiveAdapterSignWebhook(f.db, key, { signature: 'v1=deadbeef', timestamp: String(ts), eventId: 'evt-1', rawBody: body1 }, NOW)).status, 401, 'assinatura falsa');
    assert.equal((await receiveAdapterSignWebhook(f.db, key, { signature: signWebhook(body1, 'evt-1', ts - 400), timestamp: String(ts - 400), eventId: 'evt-1', rawBody: body1 }, NOW)).status, 401, 'replay antigo');

    // Cliente assinou, PDF final ainda não pronto.
    f.mock.clientSigned(envId);
    const r1 = await receiveAdapterSignWebhook(f.db, key, { signature: signWebhook(body1, 'evt-1', ts), timestamp: String(ts), eventId: 'evt-1', rawBody: body1 }, NOW);
    assert.equal(r1.status, 200);
    await processAdapterSignEvent(f.db, r1.eventRowId!, f.deps, NOW);
    assert.equal((await f.contract(c.contractId)).status, 'CLIENT_SIGNED');
    const dup = await receiveAdapterSignWebhook(f.db, key, { signature: signWebhook(body1, 'evt-1', ts), timestamp: String(ts), eventId: 'evt-1', rawBody: body1 }, NOW);
    assert.equal(dup.status, 200);
    assert.equal(dup.duplicate, true, 'evento repetido é descartado');

    // Concluído: baixa PDF final e evidências, só então COMPLETED.
    f.mock.complete(envId);
    const body2 = event('evt-2', 'envelope.completed');
    const r2 = await receiveAdapterSignWebhook(f.db, key, { signature: signWebhook(body2, 'evt-2', ts), timestamp: String(ts), eventId: 'evt-2', rawBody: body2 }, NOW);
    await processAdapterSignEvent(f.db, r2.eventRowId!, f.deps, NOW);
    const contract = await f.contract(c.contractId);
    assert.equal(contract.status, 'COMPLETED');
    assert.ok(contract.signedDocumentId && contract.evidenceDocumentId);
    const docs = await listOrderDocuments(f.db, f.tenantId, f.owner);
    assert.deepEqual(docs.map((d) => d.type).sort(), ['CONTRATO_ASSINADO', 'CONTRATO_ORIGINAL', 'EVIDENCIA_ASSINATURA']);
    const signedPdf = await readDocument(f.db, f.storage, f.tenantId, contract.signedDocumentId!, f.owner);
    assert.ok(new TextDecoder().decode(signedPdf.bytes).includes(`final ${envId}`));
    assert.ok(docs.filter((d) => d.type !== 'CONTRATO_ORIGINAL').every((d) => d.source === 'adapter_sign'));
    // Processar de novo não baixa duas vezes.
    await syncContract(f.db, f.tenantId, c.contractId, f.deps, NOW);
    assert.equal((await listOrderDocuments(f.db, f.tenantId, f.owner)).length, 3);
    // Contrato assinado mantém o pedido travado.
    await assert.rejects(() => cancelOrder(f.db, f.tenantId, c.orderId, 'desistência', f.seller, NOW), /contrato enviado/);
});

test('cancelamento e expiração liberam o pedido e permitem nova revisão com outra referência', async () => {
    const f = await fixture();
    const c = await f.newContract();
    await sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, f.deps, NOW);
    await assert.rejects(() => cancelSignature(f.db, f.tenantId, c.contractId, 'x', f.seller, f.deps, NOW), /motivo/);
    await cancelSignature(f.db, f.tenantId, c.contractId, 'Cliente pediu alteração', f.seller, f.deps, NOW);
    assert.equal((await f.contract(c.contractId)).status, 'CANCELLED');
    assert.equal([...f.mock.envelopes.values()][0].status, 'CANCELLED');
    const r2 = await generateContract(f.db, f.storage, f.tenantId, c.orderId, f.seller, NOW);
    assert.match(r2.externalRef, /-r2$/);
    await sendContractForSignature(f.db, f.tenantId, r2.contractId, f.seller, f.deps, NOW);
    const env2 = [...f.mock.envelopes.values()].find((e) => e.externalRef === r2.externalRef)!;
    f.mock.set(env2.id, 'EXPIRED');
    await reconcileSignatures(f.db, f.deps, NOW + 11 * 60_000);
    assert.equal((await f.contract(r2.contractId)).status, 'EXPIRED');
    await assert.rejects(() => newSigningLink(f.db, f.tenantId, r2.contractId, f.seller, f.deps), /aguarda a assinatura/);
    // Expirado não trava mais: o pedido pode ser corrigido e ganhar outra revisão.
    await updateOrder(f.db, f.tenantId, c.orderId, { customerId: f.customerId, unitId: c.unit, total: 850000, purchaseDate: '2026-09-26', installments: 0, downPayment: 850000, downPaymentMethod: 'Pix' }, f.seller, NOW);
    const r3 = await generateContract(f.db, f.storage, f.tenantId, c.orderId, f.seller, NOW);
    assert.match(r3.externalRef, /-r3$/);
});

test('serviço fora do ar (página HTML 404): resultado incerto preserva referência', async () => {
    const f = await fixture();
    const c = await f.newContract();
    // MOCK: simula o domínio respondendo uma página HTML genérica (serviço fora do ar/endereço errado).
    const htmlFetch: SignFetch = async () => ({ status: 404, text: async () => '<!DOCTYPE html><html><body>404</body></html>', arrayBuffer: async () => new ArrayBuffer(0) });
    await assert.rejects(() => sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, { ...f.deps, fetch: htmlFetch }, NOW), /não respondeu como API \(HTTP 404\)/);
    const contract = await f.contract(c.contractId);
    assert.equal(contract.status, 'SENDING');
    assert.match(contract.lastError, /resultado do envio é desconhecido/);
});

test('front-end respondendo {"error":"Not found"} em vez da API: tratado como API fora do ar', async () => {
    const f = await fixture();
    const c = await f.newContract();
    // MOCK: formato observado em 2026-09-26 no domínio real quando a API não está roteada.
    const webFetch: SignFetch = async () => ({ status: 404, text: async () => '{"error":"Not found"}', arrayBuffer: async () => new ArrayBuffer(0) });
    await assert.rejects(() => sendContractForSignature(f.db, f.tenantId, c.contractId, f.seller, { ...f.deps, fetch: webFetch }, NOW), /não respondeu como API/);
    assert.equal((await f.contract(c.contractId)).status, 'SENDING');
});

test('HTTP 200 com HTML não libera o contrato nem permite criar nova revisão',async()=>{
 const f=await fixture(),c=await f.newContract();
 // MOCK EXPLÍCITO de proxy que retorna HTML com HTTP 200.
 const fetch:SignFetch=async()=>({status:200,text:async()=>'<html>indisponível</html>',arrayBuffer:async()=>new ArrayBuffer(0)});
 await assert.rejects(()=>sendContractForSignature(f.db,f.tenantId,c.contractId,f.seller,{...f.deps,fetch},NOW),/resultado do envio é desconhecido/);
 assert.equal((await f.contract(c.contractId)).status,'SENDING');
 await assert.rejects(()=>generateContract(f.db,f.storage,f.tenantId,c.orderId,f.seller,NOW),/enviado/);
});

test('finalização concorrente baixa somente um par de documentos',async()=>{
 const f=await fixture(),c=await f.newContract();await sendContractForSignature(f.db,f.tenantId,c.contractId,f.seller,f.deps,NOW);
 const env=[...f.mock.envelopes.values()][0];f.mock.complete(env.id);
 await Promise.all([syncContract(f.db,f.tenantId,c.contractId,f.deps,NOW),syncContract(f.db,f.tenantId,c.contractId,f.deps,NOW)]);
 assert.equal((await listOrderDocuments(f.db,f.tenantId,f.owner)).length,3);
});

test('recusa por papéis do modelo explica quais papéis faltam ou sobram', async () => {
 const { friendlySignError } = await import('../lib/signature/service.ts');
 const { AdapterSignError } = await import('../lib/signature/adapterSign.ts');
 // Formato devolvido pelo Adapter Sign (contracts.service.ts): details { missing, unknown }.
 const msg = friendlySignError(new AdapterSignError(422, 'VALIDATION_ERROR', 'Informe exatamente um signatário para cada papel do modelo.', 'req-1', { missing: ['comprador'], unknown: ['cliente'] }), 'contrato-moto');
 assert.match(msg, /"loja" \(empresa, ordem 1\) e "cliente"/);
 assert.match(msg, /sem correspondência: "comprador"/);
 assert.match(msg, /modelo não tem: "cliente"/);
 assert.match(msg, /código req-1/);
});
