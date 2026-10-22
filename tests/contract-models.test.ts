import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { registerAccount, hashPassword } from '../lib/auth/service.ts';
import { loadPermissions } from '../lib/authz/service.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { createCustomer } from '../lib/customers/service.ts';
import { registerUnit, createOrder } from '../lib/orders/service.ts';
import { generateContract } from '../lib/contracts/service.ts';
import { readDocument } from '../lib/documents/service.ts';
import { createLocalStorage } from '../lib/storage/index.ts';
import { extractContractText } from '../lib/contracts/extract.ts';
import { parseModelBody, saveContractModel, publishContractModel, newContractModelVersion, listContractModels, previewContractModel, publishedTemplateFor } from '../lib/contracts/models.ts';
import { suspiciousFixedData } from '../lib/contracts/fields.ts';
import { rentalConditions } from '../lib/billing/service.ts';
import { saveSignatureConfig, listSignatureTemplates, sendContractForSignature } from '../lib/signature/service.ts';
import type { SignFetch } from '../lib/signature/adapterSign.ts';
import type { Actor } from '../lib/domain.ts';

process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';
const PASSWORD = 'senha-forte-123';
const NOW = Date.UTC(2026, 9, 21, 15, 0, 0); // 21/10/2026 12:00 em São Paulo

// Texto de modelo FICTÍCIO (empresa e dados inventados para teste; nada de cliente real).
const RENT_BODY = [
 'Pelo presente instrumento, de um lado a **LOCADORA: LOJA TESTE LTDA**, e de outro lado:',
 '**LOCATÁRIO: {{cliente.nome}}**, CPF {{cliente.cpf}}, residente em {{cliente.endereco_completo}}, telefone {{cliente.telefone}}.',
 '**1. DO OBJETO**',
 '**1.1.** Locação do equipamento {{produto.modelo}}, cor {{produto.cor}}, IMEI {{produto.imei}}.',
 '**2. DO ALUGUEL**',
 '**2.1.** Adesão de {{pedido.valor_adesao}} e 12 mensalidades de {{pedido.valor_mensalidade}}, todo dia {{pedido.dia_vencimento}}.',
 '**2.2.** Atraso: multa de {{contrato.multa}} e juros de {{contrato.juros}} ao mês. Garantia até {{pedido.garantia_ate}}.',
 '1. Item numerado da lista;',
 'Campinas, {{pedido.data_contrato_extenso}}.',
].join('\n\n');

async function actorFor(db: D1Database, tenantId: string, userId: string, legacyRole: string, name: string): Promise<Actor> {
 return { userId, displayName: name, role: legacyRole, storeId: null, permissions: await loadPermissions(db, userId, tenantId, legacyRole) };
}

async function fixture() {
 const db = createFakeD1();
 const storage = createLocalStorage(await mkdtemp(join(tmpdir(), 'omnihub-models-')));
 const reg = await registerAccount(db, { accountName: 'Conta Teste', displayName: 'Dona Ana', email: 'ana@teste.com', password: PASSWORD });
 const tenantId = reg.accountId;
 const owner = await actorFor(db, tenantId, reg.userId, 'admin', 'Dona Ana');
 // Loja com CNPJ que não é de nenhum modelo do código: só gera contrato com modelo próprio.
 const store = await createStore(db, tenantId, { name: 'Loja Teste', legalName: 'LOJA TESTE LTDA', cnpj: '11222333000181', modalities: ['VENDA_CONTRATO', 'LOCACAO'] } as never, owner);
 const phone = await createProduct(db, tenantId, { name: 'Celular Modelo Teste', sku: 'CEL-1', price: 0, cost: 0, minimum: 0, unit: 'UN', kind: 'LOCACAO' } as never, owner);
 const customerId = await createCustomer(db, tenantId, { name: 'Cliente Fictício da Silva', document: '52998224725', docType: 'CPF', email: 'cliente@exemplo.com', phone: '19999990000', zip: '13010000', address: 'Rua Exemplo', number: '100', complement: '', district: 'Centro', city: 'Campinas', state: 'SP' }, owner);
 const sellerId = crypto.randomUUID();
 await db.prepare('INSERT INTO users (id, display_name, email, password_hash, created_at) VALUES (?,?,?,?,?)').bind(sellerId, 'Vendedor Teste', 'vendedor@teste.com', await hashPassword(PASSWORD), 1).run();
 await db.prepare('INSERT INTO memberships (user_id, account_id, role, store_id, display_name) VALUES (?,?,?,?,?)').bind(sellerId, tenantId, 'operator', null, 'Vendedor Teste').run();
 await db.prepare('INSERT INTO user_tenant_roles (id, user_id, tenant_id, role_id) VALUES (?,?,?,?)').bind(crypto.randomUUID(), sellerId, tenantId, 'ROLE_VENDEDOR_ONLINE').run();
 const seller = await actorFor(db, tenantId, sellerId, 'operator', 'Vendedor Teste');
 let serial = 0;
 const rentOrder = async () => {
  const unit = await registerUnit(db, tenantId, { storeId: store, productId: phone, serial: `35693803564380${++serial}`, color: 'Azul', memory: '128 GB', condition: 'Seminovo' }, owner, NOW);
  return createOrder(db, tenantId, { storeId: store, type: 'LOCACAO', customerId, unitId: unit, adhesionAmount: 30000, monthlyAmount: 25000, firstDueDate: '2026-11-10', adhesionBilling: 'LOJA', adhesionPaymentMethod: 'Dinheiro' }, seller, NOW);
 };
 const draft = (patch: Record<string, unknown> = {}) => saveContractModel(db, tenantId, { storeId: store, orderType: 'LOCACAO', name: 'Locação Teste', title: 'CONTRATO DE LOCAÇÃO DE TESTE', headerText: 'LOJA TESTE LTDA\nRua da Loja, 1 - Campinas/SP', body: RENT_BODY, footerText: 'Documento gerado em {{pedido.data_hora_geracao}}', warrantyDays: 90, fineBp: 300, interestBp: 150, residualCents: 2500, ...patch }, owner, NOW);
 return { db, storage, tenantId, owner, seller, store, rentOrder, draft };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
 const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
 const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/' }).promise;
 const parts: string[] = [];
 for (let i = 1; i <= doc.numPages; i++) parts.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' '));
 return parts.join(' ').replace(/\s+/g, ' ');
}

test('texto do modelo vira blocos: cláusula em negrito é título, "1." é item recuado, o resto é parágrafo', () => {
 const blocks = parseModelBody('**1. DO OBJETO**\n\n**1.1.** Texto da\ncláusula.\n\n1. Item da lista;\n\n- outro item');
 assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'p', 'item', 'item']);
 assert.equal((blocks[0] as { text: string }).text, '1. DO OBJETO');
 assert.equal((blocks[1] as { text: string }).text, '**1.1.** Texto da cláusula.');
});

test('dados que parecem do cliente de exemplo são apontados (CPF, e-mail, telefone, IMEI, data ISO)', () => {
 const found = suspiciousFixedData('Nome {{cliente.nome}}, CPF 529.982.247-25, e-mail fulano@exemplo.com, tel 21 98901-4886, IMEI 359428794664938, garantia 2026-12-03.');
 assert.ok(found.some((f) => f.includes('529.982.247-25')));
 assert.ok(found.some((f) => f.includes('fulano@exemplo.com')));
 assert.ok(found.some((f) => f.includes('359428794664938')));
 assert.ok(found.some((f) => f.includes('2026-12-03')));
 assert.deepEqual(suspiciousFixedData('Só campos: {{cliente.cpf}} e {{cliente.email}}.'), []);
});

test('importação: PDF gerado pelo sistema volta como título, cabeçalho, rodapé e cláusulas, sem o bloco de assinaturas', async () => {
 const f = await fixture();
 const id = await f.draft();
 const pdf = await previewContractModel(f.db, f.storage, f.tenantId, id, f.owner, NOW);
 const extracted = await extractContractText(pdf);
 assert.equal(extracted.title, 'CONTRATO DE LOCAÇÃO DE TESTE');
 assert.match(extracted.headerText, /^LOJA TESTE LTDA\nRua da Loja, 1/);
 assert.match(extracted.footerText, /Documento gerado em \{\{pedido\.data_hora_geracao\}\}/);
 assert.match(extracted.body, /\*\*1\. DO OBJETO\*\*/);
 assert.match(extracted.body, /\*\*1\.1\.\*\* Locação do equipamento/);
 assert.ok(!/\[\[AS:/.test(extracted.body), 'marcas de assinatura não entram no texto');
 assert.ok(extracted.warnings.some((w) => /bloco de assinaturas/.test(w)));
});

test('publicar: confere campos obrigatórios, condições da locação e dados de exemplo antes de valer', async () => {
 const f = await fixture();
 // Sem IMEI e sem condições: bloqueia com a lista do que falta.
 const incomplete = await f.draft({ body: RENT_BODY.replace('{{produto.imei}}', '359428794664938'), fineBp: null, residualCents: null });
 await assert.rejects(() => publishContractModel(f.db, f.storage, f.tenantId, incomplete, {}, f.owner, NOW), (e: Error) => /IMEI do aparelho/.test(e.message) && /multa, juros e valor residual/.test(e.message));
 // Campo de outro tipo de pedido.
 await saveContractModel(f.db, f.tenantId, { id: incomplete, name: 'Locação Teste', title: 'X', body: RENT_BODY + '\n\nChassi {{produto.chassi_serie}}', fineBp: 300, interestBp: 150, residualCents: 2500 }, f.owner, NOW);
 await assert.rejects(() => publishContractModel(f.db, f.storage, f.tenantId, incomplete, {}, f.owner, NOW), /não existem em locação: Chassi/);
 // Dado que parece do cliente de exemplo: pede confirmação (428); confirmado, publica.
 await saveContractModel(f.db, f.tenantId, { id: incomplete, name: 'Locação Teste', title: 'CONTRATO', body: RENT_BODY + '\n\nContato da loja: loja@exemplo.com', fineBp: 300, interestBp: 150, residualCents: 2500, warrantyDays: 90 }, f.owner, NOW);
 await assert.rejects(() => publishContractModel(f.db, f.storage, f.tenantId, incomplete, {}, f.owner, NOW), (e: Error & { status?: number }) => e.status === 428 && /loja@exemplo\.com/.test(e.message));
 await publishContractModel(f.db, f.storage, f.tenantId, incomplete, { confirmFixedData: true }, f.owner, NOW);
 const models = await listContractModels(f.db, f.tenantId, f.store, f.owner);
 assert.equal(models[0].status, 'PUBLISHED');
 // Publicado não muda; vendedor não gerencia modelos.
 await assert.rejects(() => saveContractModel(f.db, f.tenantId, { id: incomplete, name: 'Outro' }, f.owner, NOW), /Nova versão/);
 await assert.rejects(() => listContractModels(f.db, f.tenantId, f.store, f.seller), /permissão/);
});

test('contrato pelo modelo da loja: sem trava de CNPJ, visual da loja, campos preenchidos e condições no snapshot', async () => {
 const f = await fixture();
 const orderBefore = await f.rentOrder();
 // Sem modelo próprio, a loja (CNPJ de outra empresa) não usa o modelo padrão de locação.
 await assert.rejects(() => generateContract(f.db, f.storage, f.tenantId, orderBefore, f.seller, NOW), /Minhas lojas > Modelos de contrato/);
 const id = await f.draft();
 await publishContractModel(f.db, f.storage, f.tenantId, id, { confirmFixedData: true }, f.owner, NOW);
 const result = await generateContract(f.db, f.storage, f.tenantId, orderBefore, f.seller, NOW);
 assert.match(result.externalRef, /^pedido-\d+-modelo-loja-locacao-v1-r1$/);
 const text = await pdfText((await readDocument(f.db, f.storage, f.tenantId, result.documentId, f.seller)).bytes);
 for (const expected of ['LOJA TESTE LTDA', 'CONTRATO DE LOCAÇÃO DE TESTE', 'Cliente Fictício da Silva', '529.982.247-25', '(19) 99999-0000', 'R$ 300,00', 'R$ 250,00', 'multa de 3% e juros de 1,5%', 'Garantia até 19/01/2027', 'Campinas, 21 de outubro de 2026', 'Documento gerado em 21/10/2026 12:00', 'Página 01', '[[AS:assinatura:loja]]', '[[AS:assinatura:cliente]]', 'CNPJ 11.222.333/0001-81']) {
  assert.ok(text.includes(expected), `PDF deveria conter "${expected}"`);
 }
 assert.ok(!/\{\{/.test(text), 'nenhum campo sem substituir');
 const snap = JSON.parse((await f.db.prepare('SELECT payload_snapshot AS s FROM contracts WHERE id = ?').bind(result.contractId).first<{ s: string }>())!.s);
 assert.equal(snap.template.modelId, id);
 assert.deepEqual(snap.template.conditions, { warrantyDays: 90, fineBp: 300, interestBp: 150, residualCents: 2500 });
 // Boletos da locação usam as condições do contrato do pedido.
 const order = await f.db.prepare('SELECT store_id AS s FROM orders WHERE id = ?').bind(orderBefore).first<{ s: string }>();
 assert.deepEqual(await rentalConditions(f.db, f.tenantId, orderBefore, order!.s), { fineBp: 300, interestBp: 150, residualCents: 2500 });
});

test('nova versão: rascunho copiado, publicar arquiva a anterior; contratos novos usam a versão nova', async () => {
 const f = await fixture();
 const v1 = await f.draft();
 await publishContractModel(f.db, f.storage, f.tenantId, v1, { confirmFixedData: true }, f.owner, NOW);
 const v2 = await newContractModelVersion(f.db, f.tenantId, v1, f.owner, NOW);
 await assert.rejects(() => newContractModelVersion(f.db, f.tenantId, v1, f.owner, NOW), /Já existe um rascunho/);
 await saveContractModel(f.db, f.tenantId, { id: v2, name: 'Locação Teste', title: 'CONTRATO DE LOCAÇÃO V2', headerText: 'LOJA TESTE LTDA', body: RENT_BODY, footerText: '', warrantyDays: 90, fineBp: 200, interestBp: 100, residualCents: 1990 }, f.owner, NOW);
 await publishContractModel(f.db, f.storage, f.tenantId, v2, { confirmFixedData: true }, f.owner, NOW);
 const models = await listContractModels(f.db, f.tenantId, f.store, f.owner);
 assert.deepEqual(models.map((m) => [m.version, m.status]), [[2, 'PUBLISHED'], [1, 'ARCHIVED']]);
 const template = await publishedTemplateFor(f.db, f.storage, f.tenantId, f.store, 'LOCACAO');
 assert.equal(template?.version, 2);
 assert.equal(template?.conditions?.fineBp, 200);
});

/**
 * MOCK do Adapter Sign (só neste teste): GET /templates e POST /envelopes/from-template no formato
 * de docs/api.md do Adapter Sign. Nenhuma chamada real.
 */
function signMock() {
 const sent: Record<string, unknown>[] = [];
 const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });
 const fetch: SignFetch = async (url, init) => {
  const path = url.replace(/^https:\/\/[^/]+\/api\/v1/, '');
  if (init.method === 'GET' && path === '/templates') return json(200, [
   { id: 't1', key: 'locacao-samuca', name: 'Locação', description: '', signingMode: 'SEQUENTIAL', roles: [{ key: 'empresa', label: 'Empresa', signingGroup: 1, isCompany: true }, { key: 'locatario', label: 'Locatário', signingGroup: 2, isCompany: false }] },
   { id: 't2', key: 'com-testemunha', name: 'Com testemunha', description: '', signingMode: 'SEQUENTIAL', roles: [{ key: 'empresa', label: 'Empresa', signingGroup: 1, isCompany: true }, { key: 'cliente', label: 'Cliente', signingGroup: 2, isCompany: false }, { key: 'testemunha', label: 'Testemunha', signingGroup: 3, isCompany: false }] },
  ]);
  if (init.method === 'POST' && path === '/envelopes/from-template') {
   const data = JSON.parse(String((init.body as FormData).get('data')));
   sent.push(data);
   return json(201, { id: 'env-1', status: 'IN_PROGRESS', externalRef: data.externalRef, validationCode: 'ABC', replayed: false, documents: [{ id: 'doc-1', filename: 'c.pdf', originalSha256: 'x' }], signers: data.signers.map((s: { role: string; name: string }, i: number) => ({ id: `sig-${i}`, role: s.role, name: s.name, status: i === 0 ? 'SIGNED' : 'PENDING', signingUrl: i === 1 ? 'https://sign.exemplo.test/x' : null, signingUrlExpiresAt: null })) });
  }
  return json(404, { error: { code: 'NOT_FOUND', message: 'rota não simulada' } });
 };
 return { fetch, sent };
}

test('assinatura: modelos do Adapter Sign listados (com motivo quando não servem) e envio com os papéis do modelo escolhido', async () => {
 const f = await fixture();
 const mock = signMock();
 const deps = { fetch: mock.fetch, storage: f.storage, baseUrl: 'https://sign.exemplo.test/api/v1' };
 await assert.rejects(() => listSignatureTemplates(f.db, f.tenantId, f.store, f.owner, deps), /Configure primeiro a assinatura eletrônica/);
 await saveSignatureConfig(f.db, f.tenantId, f.store, { apiKey: 'as_live_TESTE_MOCK_123456', webhookSecret: 'segredo-de-teste-mock-123', motoTemplate: '', locacaoTemplate: '' }, f.owner, NOW);
 const options = await listSignatureTemplates(f.db, f.tenantId, f.store, f.owner, deps);
 assert.deepEqual(options.map((o) => [o.key, o.companyRole, o.clientRole, !!o.problem]), [['locacao-samuca', 'empresa', 'locatario', false], ['com-testemunha', null, null, true]]);
 const id = await f.draft({ signTemplateKey: 'locacao-samuca', signCompanyRole: 'empresa', signClientRole: 'locatario' });
 await publishContractModel(f.db, f.storage, f.tenantId, id, { confirmFixedData: true }, f.owner, NOW);
 const contract = await generateContract(f.db, f.storage, f.tenantId, await f.rentOrder(), f.seller, NOW);
 const text = await pdfText((await readDocument(f.db, f.storage, f.tenantId, contract.documentId, f.seller)).bytes);
 assert.ok(text.includes('[[AS:assinatura:empresa]]') && text.includes('[[AS:assinatura:locatario]]'), 'marcas com os papéis do modelo escolhido');
 const result = await sendContractForSignature(f.db, f.tenantId, contract.contractId, f.seller, deps, NOW);
 assert.equal(result.signingUrl, 'https://sign.exemplo.test/x');
 assert.equal(mock.sent[0].template, 'locacao-samuca');
 assert.deepEqual((mock.sent[0].signers as { role: string }[]).map((s) => s.role), ['empresa', 'locatario']);
});
