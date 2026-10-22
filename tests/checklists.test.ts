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
import { generateContract, listContracts } from '../lib/contracts/service.ts';
import { readDocument } from '../lib/documents/service.ts';
import { createLocalStorage } from '../lib/storage/index.ts';
import { parseChecklistItems, saveChecklistTemplate, checklistTemplateForOrder, generateChecklist, listChecklistTemplates } from '../lib/checklists/service.ts';
import { saveSignatureConfig, listSignatureTemplates, sendContractForSignature } from '../lib/signature/service.ts';
import type { SignFetch } from '../lib/signature/adapterSign.ts';
import type { Actor } from '../lib/domain.ts';

process.env.FISCAL_SECRET_KEY ??= 'test-only-fiscal-secret-key-not-for-production!!';
const PASSWORD = 'senha-forte-123';
const NOW = Date.UTC(2026, 9, 22, 15, 0, 0); // 22/10/2026 12:00 em São Paulo
const ITEMS = '# VISUALIZAÇÃO EXTERNA\nCarenagem completa\nParalama\n\n# ACOMPANHA\n1 carregador\n2 jogos de chaves';

async function actorFor(db: D1Database, tenantId: string, userId: string, legacyRole: string, name: string): Promise<Actor> {
 return { userId, displayName: name, role: legacyRole, storeId: null, permissions: await loadPermissions(db, userId, tenantId, legacyRole) };
}

// Dados FICTÍCIOS de teste. A loja usa o CNPJ da empresa dona do modelo de moto do código, para o
// contrato padrão também poder ser gerado e conferir que checklist e contrato não se misturam.
async function fixture() {
 const db = createFakeD1();
 const storage = createLocalStorage(await mkdtemp(join(tmpdir(), 'omnihub-checklist-')));
 const reg = await registerAccount(db, { accountName: 'Conta Teste', displayName: 'Dona Ana', email: 'ana@teste.com', password: PASSWORD });
 const tenantId = reg.accountId;
 const owner = await actorFor(db, tenantId, reg.userId, 'admin', 'Dona Ana');
 const store = await createStore(db, tenantId, { name: 'Loja Motos', legalName: 'LOJA MOTOS TESTE LTDA', cnpj: '65715457000128', modalities: ['VENDA_CONTRATO'] } as never, owner);
 const moto = await createProduct(db, tenantId, { name: 'Scooter Teste X1', sku: 'MOTO-1', price: 900000, cost: 1, minimum: 0, unit: 'UN', kind: 'MOTO' } as never, owner);
 const customerId = await createCustomer(db, tenantId, { name: 'Cliente Fictício', document: '52998224725', docType: 'CPF', email: 'cliente@exemplo.com', phone: '19999990000', zip: '13010000', address: 'Rua Exemplo', number: '100', complement: '', district: 'Centro', city: 'Campinas', state: 'SP' }, owner);
 const sellerId = crypto.randomUUID();
 await db.prepare('INSERT INTO users (id, display_name, email, password_hash, created_at) VALUES (?,?,?,?,?)').bind(sellerId, 'Vendedor Teste', 'vendedor@teste.com', await hashPassword(PASSWORD), 1).run();
 await db.prepare('INSERT INTO memberships (user_id, account_id, role, store_id, display_name) VALUES (?,?,?,?,?)').bind(sellerId, tenantId, 'operator', null, 'Vendedor Teste').run();
 await db.prepare('INSERT INTO user_tenant_roles (id, user_id, tenant_id, role_id) VALUES (?,?,?,?)').bind(crypto.randomUUID(), sellerId, tenantId, 'ROLE_VENDEDOR_ONLINE').run();
 const seller = await actorFor(db, tenantId, sellerId, 'operator', 'Vendedor Teste');
 const unit = await registerUnit(db, tenantId, { storeId: store, productId: moto, serial: 'CHASSI0TESTE001', color: 'Preta' }, owner, NOW);
 const orderId = await createOrder(db, tenantId, { storeId: store, type: 'VENDA', customerId, unitId: unit, total: 900000, purchaseDate: '2026-10-22', installments: 0, downPayment: 900000, downPaymentMethod: 'Pix', saleChannel: 'PRESENCIAL' }, seller, NOW);
 const save = (patch: Record<string, unknown> = {}) => saveChecklistTemplate(db, tenantId, { storeId: store, orderType: 'VENDA', title: 'DOCUMENTO DE ENTREGA', items: ITEMS, declaration: 'Eu, {{cliente.nome}}, CPF {{cliente.cpf}}, declaro que recebi o produto nas condições acima.', ...patch }, owner, NOW);
 return { db, storage, tenantId, owner, seller, store, orderId, save };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
 const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
 const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/' }).promise;
 const parts: string[] = [];
 for (let i = 1; i <= doc.numPages; i++) parts.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' '));
 return parts.join(' ').replace(/\s+/g, ' ');
}

test('itens do checklist: "#" abre seção, cada linha é um item, linhas vazias são ignoradas', () => {
 assert.deepEqual(parseChecklistItems('Item solto\n# SEÇÃO A\nA1\n\nA2\n# VAZIA\n# SEÇÃO B\nB1'), [
  { title: '', items: ['Item solto'] }, { title: 'SEÇÃO A', items: ['A1', 'A2'] }, { title: 'SEÇÃO B', items: ['B1'] },
 ]);
});

test('modelo do checklist da loja: validações e permissão', async () => {
 const f = await fixture();
 await assert.rejects(() => f.save({ items: '# SÓ SEÇÃO' }), /pelo menos um item/);
 await assert.rejects(() => f.save({ items: 'Item {{cliente.nome}}' }), /não usam campos/);
 await assert.rejects(() => f.save({ declaration: 'Eu, {{cliente.apelido}}' }), /Campos desconhecidos/);
 await assert.rejects(() => f.save({ declaration: 'IMEI {{produto.imei}}' }), /não existem em venda: IMEI/);
 await assert.rejects(() => saveChecklistTemplate(f.db, f.tenantId, { storeId: f.store, orderType: 'VENDA', title: 'X', items: ITEMS }, f.seller, NOW), /permissão/);
 await f.save();
 await f.save({ title: 'TERMO DE ENTREGA' }); // salvar de novo atualiza (um por loja e tipo)
 const list = await listChecklistTemplates(f.db, f.tenantId, f.store, f.owner);
 assert.equal(list.length, 1);
 assert.equal(list[0].title, 'TERMO DE ENTREGA');
 const forOrder = await checklistTemplateForOrder(f.db, f.tenantId, f.orderId, f.seller);
 assert.deepEqual(forOrder?.sections.map((s) => s.items.length), [2, 2]);
});

test('checklist do pedido: dados do pedido no PDF, itens marcados, observações e declaração; não se mistura com o contrato', async () => {
 const f = await fixture();
 await assert.rejects(() => generateChecklist(f.db, f.storage, f.tenantId, f.orderId, { checked: [] }, f.seller, NOW), /ainda não tem checklist de entrega/);
 await f.save();
 const tpl = await checklistTemplateForOrder(f.db, f.tenantId, f.orderId, f.seller);
 await assert.rejects(() => generateChecklist(f.db, f.storage, f.tenantId, f.orderId, { checked: ['9:9'] }, f.seller, NOW), /Item do checklist inválido/);
 await assert.rejects(() => generateChecklist(f.db, f.storage, f.tenantId, f.orderId, { checked: [], templateUpdatedAt: 1 }, f.seller, NOW), /foi alterado enquanto você marcava/);
 const contract = await generateContract(f.db, f.storage, f.tenantId, f.orderId, f.seller, NOW);
 const r1 = await generateChecklist(f.db, f.storage, f.tenantId, f.orderId, { checked: ['0:0', '1:1'], observations: 'Risco leve no paralama.', templateUpdatedAt: tpl!.updatedAt }, f.seller, NOW);
 assert.equal(r1.externalRef, 'pedido-1-checklist-r1');
 const text = await pdfText((await readDocument(f.db, f.storage, f.tenantId, r1.documentId, f.seller)).bytes);
 for (const expected of ['DOCUMENTO DE ENTREGA', 'Cliente Fictício', '529.982.247-25', 'Scooter Teste X1', 'CHASSI0TESTE001', 'Preta', 'Garantia até', '20/01/2027', 'VISUALIZAÇÃO EXTERNA', '(X) Carenagem completa', '( ) Paralama', '(X) 2 jogos de chaves', 'Risco leve no paralama.', 'Eu, Cliente Fictício, CPF 529.982.247-25, declaro', 'Página 01', '[[AS:assinatura:cliente]]']) {
  assert.ok(text.includes(expected), `PDF deveria conter "${expected}"`);
 }
 assert.ok(!/\{\{/.test(text));
 // Gerar de novo substitui o checklist anterior, sem tocar no contrato.
 const r2 = await generateChecklist(f.db, f.storage, f.tenantId, f.orderId, { checked: [] }, f.seller, NOW + 1000);
 assert.equal(r2.externalRef, 'pedido-1-checklist-r2');
 const all = await listContracts(f.db, f.tenantId, f.owner);
 const byId = new Map(all.map((c) => [c.id, c]));
 assert.equal(byId.get(contract.contractId)?.status, 'GENERATED', 'o contrato continua vigente');
 assert.equal(byId.get(contract.contractId)?.documentKind, 'CONTRATO');
 assert.equal(byId.get(r1.contractId)?.status, 'SUPERSEDED');
 assert.equal(byId.get(r2.contractId)?.documentKind, 'CHECKLIST');
 // E uma revisão nova do contrato não mexe no checklist.
 await generateContract(f.db, f.storage, f.tenantId, f.orderId, f.seller, NOW + 2000);
 assert.equal((await listContracts(f.db, f.tenantId, f.owner)).find((c) => c.id === r2.contractId)?.status, 'GENERATED');
});

/** MOCK do Adapter Sign (só neste teste): GET /templates e POST /envelopes/from-template. */
function signMock() {
 const sent: Record<string, unknown>[] = [];
 const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });
 const fetch: SignFetch = async (url, init) => {
  const path = url.replace(/^https:\/\/[^/]+\/api\/v1/, '');
  if (init.method === 'GET' && path === '/templates') return json(200, [
   { id: 't1', key: 'checklist-entrega', name: 'Checklist', roles: [{ key: 'comprador', label: 'Comprador', signingGroup: 1, isCompany: false }] },
   { id: 't2', key: 'sem-cliente', name: 'Só empresa', roles: [{ key: 'empresa', label: 'Empresa', signingGroup: 1, isCompany: true }] },
  ]);
  if (init.method === 'POST' && path === '/envelopes/from-template') {
   const data = JSON.parse(String((init.body as FormData).get('data')));
   sent.push(data);
   return json(201, { id: 'env-9', status: 'IN_PROGRESS', externalRef: data.externalRef, validationCode: 'XYZ', replayed: false, documents: [{ id: 'doc-9', filename: 'c.pdf', originalSha256: 'x' }], signers: data.signers.map((s: { role: string; name: string }, i: number) => ({ id: `sig-${i}`, role: s.role, name: s.name, status: 'PENDING', signingUrl: 'https://sign.exemplo.test/checklist', signingUrlExpiresAt: null })) });
  }
  return json(404, { error: { code: 'NOT_FOUND', message: 'rota não simulada' } });
 };
 return { fetch, sent };
}

test('assinatura do checklist: modelo só com o cliente aceito; envio sem a loja assinar; sem modelo escolhido, explica', async () => {
 const f = await fixture();
 const mock = signMock();
 const deps = { fetch: mock.fetch, storage: f.storage, baseUrl: 'https://sign.exemplo.test/api/v1' };
 await saveSignatureConfig(f.db, f.tenantId, f.store, { apiKey: 'as_live_TESTE_MOCK_123456', webhookSecret: 'segredo-de-teste-mock-123', motoTemplate: 'contrato-moto', locacaoTemplate: '' }, f.owner, NOW);
 const forContract = await listSignatureTemplates(f.db, f.tenantId, f.store, f.owner, deps);
 assert.ok(forContract.find((o) => o.key === 'checklist-entrega')?.problem, 'contrato exige papel da empresa');
 const forChecklist = await listSignatureTemplates(f.db, f.tenantId, f.store, f.owner, deps, { clientOnlyAllowed: true });
 assert.deepEqual(forChecklist.map((o) => [o.key, o.companyRole, o.clientRole, !!o.problem]), [['checklist-entrega', '', 'comprador', false], ['sem-cliente', null, null, true]]);
 // Sem modelo de assinatura no checklist: gera, mas não envia (o do contrato não serve).
 await f.save();
 const noSign = await generateChecklist(f.db, f.storage, f.tenantId, f.orderId, { checked: ['0:0'] }, f.seller, NOW);
 await assert.rejects(() => sendContractForSignature(f.db, f.tenantId, noSign.contractId, f.seller, deps, NOW), /modelo de assinatura do checklist/);
 await f.save({ signTemplateKey: 'checklist-entrega', signCompanyRole: '', signClientRole: 'comprador' });
 const withSign = await generateChecklist(f.db, f.storage, f.tenantId, f.orderId, { checked: ['0:0'] }, f.seller, NOW + 1000);
 const text = await pdfText((await readDocument(f.db, f.storage, f.tenantId, withSign.documentId, f.seller)).bytes);
 assert.ok(text.includes('[[AS:assinatura:comprador]]') && !text.includes('[[AS:assinatura:loja]]'), 'só o cliente assina');
 const result = await sendContractForSignature(f.db, f.tenantId, withSign.contractId, f.seller, deps, NOW + 2000);
 assert.equal(result.signingUrl, 'https://sign.exemplo.test/checklist');
 assert.equal(mock.sent[0].template, 'checklist-entrega');
 assert.deepEqual((mock.sent[0].signers as { role: string }[]).map((s) => s.role), ['comprador']);
 assert.match(String(mock.sent[0].title), /^Checklist de entrega #1 - Cliente Fictício/);
});
