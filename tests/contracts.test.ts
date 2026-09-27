import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { registerAccount, hashPassword } from '../lib/auth/service.ts';
import { loadPermissions } from '../lib/authz/service.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { createCustomer, updateCustomer } from '../lib/customers/service.ts';
import { registerUnit, createOrder, updateOrder, cancelOrder } from '../lib/orders/service.ts';
import { generateContract, listContracts, buildContractValues } from '../lib/contracts/service.ts';
import { TEMPLATES, placeholdersOf } from '../lib/contracts/templates.ts';
import { uploadOrderDocument, readDocument, deleteDocument, listOrderDocuments, detectFileType } from '../lib/documents/service.ts';
import { createLocalStorage, storageFromEnv, assertSafeKey } from '../lib/storage/index.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import type { Actor } from '../lib/domain.ts';

const PASSWORD = 'senha-forte-123';
const plan = { status: 'active', accessUntil: 9_999_999_999_999, maxStores: 3 };
// "Agora" do teste: 2026-09-26 12:00 em São Paulo.
const NOW = Date.UTC(2026, 8, 26, 15, 0, 0);

/** Extrai o texto do PDF como o Adapter Sign faria (pdfjs), página a página. */
async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/' }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        parts.push(content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join(''));
    }
    // Quebras de linha do layout viram espaço: o que importa é a sequência de texto.
    return { text: parts.join(' ').replace(/\s+/g, ' '), pages: doc.numPages };
}

async function addMember(db: D1Database, tenantId: string, opts: { email: string; roleId: string; name: string; storeId?: string | null }) {
    const userId = crypto.randomUUID();
    await db.prepare('INSERT INTO users (id, display_name, email, password_hash, created_at) VALUES (?,?,?,?,?)').bind(userId, opts.name, opts.email, await hashPassword(PASSWORD), 1).run();
    await db.prepare('INSERT INTO memberships (user_id, account_id, role, store_id, display_name) VALUES (?,?,?,?,?)').bind(userId, tenantId, 'operator', opts.storeId ?? null, opts.name).run();
    await db.prepare('INSERT INTO user_tenant_roles (id, user_id, tenant_id, role_id) VALUES (?,?,?,?)').bind(crypto.randomUUID(), userId, tenantId, opts.roleId).run();
    return userId;
}
async function actorFor(db: D1Database, tenantId: string, userId: string, legacyRole: string, name: string, storeId: string | null = null): Promise<Actor> {
    return { userId, displayName: name, role: legacyRole, storeId, permissions: await loadPermissions(db, userId, tenantId, legacyRole) };
}

async function fixture() {
    const db = createFakeD1();
    const storage = createLocalStorage(await mkdtemp(join(tmpdir(), 'omnihub-docs-')));
    const reg = await registerAccount(db, { accountName: 'Grupo Teste', displayName: 'Dona Ana', email: 'ana@teste.com', password: PASSWORD });
    const tenantId = reg.accountId;
    const owner = await actorFor(db, tenantId, reg.userId, 'admin', 'Dona Ana');
    // CNPJs das empresas donas dos modelos (dados do próprio modelo, confirmados pelo usuário).
    const dmax = await createStore(db, tenantId, { name: 'D-MAX', cnpj: '65715457000128', modalities: ['VENDA_CONTRATO'] } as never, owner);
    const cell = await createStore(db, tenantId, { name: 'Grupo Cell', cnpj: '15243489000108', modalities: ['LOCACAO'] } as never, owner);
    const other = await createStore(db, tenantId, { name: 'Outra Loja', cnpj: '11222333000181', modalities: ['VENDA_CONTRATO'] } as never, owner);
    const moto = await createProduct(db, tenantId, { name: 'Scooter Elétrica X1', sku: 'MOTO-1', price: 900000, cost: 1, minimum: 0, unit: 'UN', kind: 'MOTO' } as never, owner);
    const phone = await createProduct(db, tenantId, { name: 'iPhone 13', sku: 'IPH-13', price: 0, cost: 0, minimum: 0, unit: 'UN', kind: 'LOCACAO' } as never, owner);
    const customerId = await createCustomer(db, tenantId, { name: 'Maria da Conceição Araújo', document: '52998224725', docType: 'CPF', email: 'maria@exemplo.com', phone: '24999990000', zip: '27260000', address: 'Rua São João', number: '10', complement: 'Apto 201', district: 'Aterrado', city: 'Volta Redonda', state: 'RJ' }, owner);
    const sellerId = await addMember(db, tenantId, { email: 'online@teste.com', roleId: 'ROLE_VENDEDOR_ONLINE', name: 'Vendedor Online' });
    const seller = await actorFor(db, tenantId, sellerId, 'operator', 'Vendedor Online');
    return { db, storage, tenantId, owner, seller, dmax, cell, other, moto, phone, customerId };
}

async function motoOrder(f: Awaited<ReturnType<typeof fixture>>, storeId = f.dmax, serial = 'LXYJCBL01P0123456') {
    const unit = await registerUnit(f.db, f.tenantId, { storeId, productId: f.moto, serial, color: 'Vermelha' }, f.owner, NOW);
    return createOrder(f.db, f.tenantId, { storeId, type: 'VENDA', customerId: f.customerId, unitId: unit, total: 900000, purchaseDate: '2026-09-26', installments: 10, downPayment: 200000, downPaymentMethod: 'Pix', firstDueDate: '2026-10-26' }, f.seller, NOW);
}

test('modelos: todo placeholder usado no texto tem valor com dados completos; nada fica sem substituir', () => {
    for (const template of TEMPLATES) {
        const src = {
            order: { id: 'o', number: 7, type: template.orderType, status: 'OPEN', storeId: 's', customerId: 'c', total: 900000, purchaseDate: '2026-09-26', downPayment: 0, downPaymentMethod: 'Pix', installments: 0, firstDueDate: '', adhesionAmount: 30000, monthlyAmount: 25000, dueDay: 10 },
            store: { id: 's', name: 'Loja', cnpj: template.ownerCnpj },
            customer: { name: 'Fulano', document: '52998224725', docType: 'CPF', email: 'f@x.com', phone: '2433334444', zip: '27260000', address: 'Rua A', number: '1', complement: '', district: 'Centro', city: 'Volta Redonda', state: 'RJ' },
            unit: { serial: template.orderType === 'VENDA' ? 'CH-1' : '356938035643809', color: 'Azul', memory: '128 GB', condition: 'Seminovo', productName: 'Modelo' },
        };
        const values = buildContractValues(template, src as never, NOW);
        for (const key of placeholdersOf(template)) assert.ok(values[key], `${template.key}: placeholder ${key} sem valor`);
    }
});

test('contrato da moto: PDF com dados reais, garantia calculada, marcadores como texto e sem placeholders', async () => {
    const f = await fixture();
    const orderId = await motoOrder(f);
    const result = await generateContract(f.db, f.storage, f.tenantId, orderId, f.seller, NOW);
    assert.equal(result.externalRef, 'pedido-1-contrato-moto-v1-r1');
    const doc = await readDocument(f.db, f.storage, f.tenantId, result.documentId, f.seller);
    assert.equal(doc.mimeType, 'application/pdf');
    const { text } = await pdfText(doc.bytes);
    for (const expected of [
        'CONTRATO DE COMPRA E VENDA E TERMO DE GARANTIA E QUALIDADE',
        'VENDEDOR (CONTRATADA): D-MAX MOBILIDADE URBANA',
        'Maria da Conceição Araújo',
        '529.982.247-25',
        'Rua São João, 10, Apto 201, Aterrado, Volta Redonda - RJ, CEP 27260-000',
        '(24) 99999-0000 / maria@exemplo.com',
        'Scooter Elétrica X1',
        'LXYJCBL01P0123456',
        'Vermelha',
        '26/09/2026',
        'R$ 9.000,00',
        'Entrada de R$ 2.000,00 (Pix) + R$ 7.000,00 em 10 parcelas no boleto bancário, com 1º vencimento em 26/10/2026',
        'encerrando-se em: 25/12/2026',
        'Volta Redonda - RJ, 26/09/2026',
        'MARIA DA CONCEIÇÃO ARAÚJO',
        '[[AS:assinatura:loja]]',
        '[[AS:assinatura:cliente]]',
        'artigo 26, inciso II do Código de Defesa do Consumidor',
    ]) assert.ok(text.includes(expected), `faltou no PDF: ${expected}`);
    for (const forbidden of ['{{', '}}', '[Nome do Cliente]', '[Contato]', '[Data de Término', '__/__/__', '**']) assert.ok(!text.includes(forbidden), `sobrou no PDF: ${forbidden}`);
    const [contract] = await listContracts(f.db, f.tenantId, f.seller);
    assert.equal(contract.status, 'GENERATED');
    assert.equal(contract.templateKey, 'contrato-moto');
    assert.match(contract.originalSha256, /^[a-f0-9]{64}$/);
    const snapshot = JSON.parse((await f.db.prepare('SELECT payload_snapshot AS s FROM contracts WHERE id = ?').bind(contract.id).first<{ s: string }>())!.s);
    assert.equal(snapshot.values['pedido.garantia_ate'], '25/12/2026');
    // O contrato não muda se o cadastro mudar depois (snapshot + PDF imutáveis).
    await updateCustomer(f.db, f.tenantId, f.customerId, { name: 'Outro Nome' }, f.owner);
    const again = await readDocument(f.db, f.storage, f.tenantId, result.documentId, f.seller);
    assert.ok((await pdfText(again.bytes)).text.includes('Maria da Conceição Araújo'));
});

test('contrato de locação: CNPJ corrigido, MINUTA, 12 mensalidades, data por extenso, CPF na assinatura', async () => {
    const f = await fixture();
    const unit = await registerUnit(f.db, f.tenantId, { storeId: f.cell, productId: f.phone, serial: '356938035643809', color: 'Azul', memory: '128 GB', condition: 'Seminovo' }, f.owner, NOW);
    const orderId = await createOrder(f.db, f.tenantId, { storeId: f.cell, type: 'LOCACAO', customerId: f.customerId, unitId: unit, adhesionAmount: 30000, monthlyAmount: 25000, dueDay: 10, adhesionBilling: 'BOLETO' }, f.seller, NOW);
    const result = await generateContract(f.db, f.storage, f.tenantId, orderId, f.seller, NOW);
    const { text, pages } = await pdfText((await readDocument(f.db, f.storage, f.tenantId, result.documentId, f.seller)).bytes);
    assert.ok(pages >= 5, 'contrato longo paginado');
    for (const expected of [
        'MINUTA DE CONTRATO: LOCAÇÃO DE EQUIPAMENTO ELETRÔNICO COM OPÇÃO DE COMPRA',
        'F C Eletrônicos LTDA - ME, 15.243.489/0001-08',
        'PORTADOR DO CPF DE NÚMERO 529.982.247-25',
        'iPhone 13, cor Azul, memória 128 GB, IMEI 356938035643809 e estado do aparelho: Seminovo',
        'quantia de R$ 300,00',
        '12 (doze) mensalidades de R$ 250,00, com vencimento todo dia 10 de cada mês',
        'R$ 19,90 (dezenove reais e noventa centavos)',
        '(24) 99940-3331',
        'Volta Redonda, 26 de setembro de 2026',
        'MARIA DA CONCEIÇÃO ARAÚJO - CPF 529.982.247-25',
        '[[AS:assinatura:loja]]',
        '[[AS:assinatura:cliente]]',
    ]) assert.ok(text.includes(expected), `faltou no PDF: ${expected}`);
    for (const forbidden of ['15.243.489.999', 'NOME COMPLETO DO CLIENTE', 'VALOR DO ALUGUEL', 'DATA DE VENCIMENTO', 'MODELO DO IPHONE', '{{']) assert.ok(!text.includes(forbidden), `sobrou no PDF: ${forbidden}`);
});

test('contrato bloqueia: loja com outro CNPJ, dados faltando (lista objetiva), locação sem CPF e caracteres não suportados', async () => {
    const f = await fixture();
    const otherOrder = await motoOrder(f, f.other, 'OUTRO-1');
    await assert.rejects(() => generateContract(f.db, f.storage, f.tenantId, otherOrder, f.seller, NOW), /é da empresa D-MAX MOBILIDADE URBANA, CNPJ 65\.715\.457\/0001-28/);

    const orderId = await motoOrder(f);
    await updateCustomer(f.db, f.tenantId, f.customerId, { email: '', number: '' }, f.owner);
    await assert.rejects(() => generateContract(f.db, f.storage, f.tenantId, orderId, f.seller, NOW), (e: Error) => e.message.startsWith('Não foi possível gerar o contrato. Preencha:') && e.message.includes('endereço completo') && e.message.includes('e-mail do cliente'));
    await updateCustomer(f.db, f.tenantId, f.customerId, { email: 'maria@exemplo.com', number: '10', name: 'Maria 😀' }, f.owner);
    await assert.rejects(() => generateContract(f.db, f.storage, f.tenantId, orderId, f.seller, NOW), /caracteres não suportados em nome do cliente/);
    // Marcação dentro do dado do cliente vira texto literal, não formatação.
    await updateCustomer(f.db, f.tenantId, f.customerId, { name: 'Maria **Negrito** __It__' }, f.owner);
    const ok = await generateContract(f.db, f.storage, f.tenantId, orderId, f.seller, NOW);
    assert.ok((await pdfText((await readDocument(f.db, f.storage, f.tenantId, ok.documentId, f.seller)).bytes)).text.includes('Maria **Negrito** __It__'));

    const cnpjCustomer = await createCustomer(f.db, f.tenantId, { name: 'Empresa X', document: '11222333000181', docType: 'CNPJ', email: 'x@x.com', phone: '2433334444', zip: '27260000', address: 'Rua B', number: '2', district: 'Centro', city: 'Volta Redonda', state: 'RJ' }, f.owner);
    const unit = await registerUnit(f.db, f.tenantId, { storeId: f.cell, productId: f.phone, serial: '490154203237518', color: 'Preto', memory: '64 GB', condition: 'Novo' }, f.owner, NOW);
    const rent = await createOrder(f.db, f.tenantId, { storeId: f.cell, type: 'LOCACAO', customerId: cnpjCustomer, unitId: unit, adhesionAmount: 30000, monthlyAmount: 25000, dueDay: 5, adhesionBilling: 'BOLETO' }, f.seller, NOW);
    await assert.rejects(() => generateContract(f.db, f.storage, f.tenantId, rent, f.seller, NOW), /CPF do cliente \(a locação exige CPF\)/);
});

test('revisões: gerar de novo substitui a anterior; alterar o pedido invalida; cancelar cancela; nada é apagado', async () => {
    const f = await fixture();
    const orderId = await motoOrder(f);
    await generateContract(f.db, f.storage, f.tenantId, orderId, f.seller, NOW);
    const second = await generateContract(f.db, f.storage, f.tenantId, orderId, f.seller, NOW + 1000);
    assert.equal(second.externalRef, 'pedido-1-contrato-moto-v1-r2');
    let contracts = await listContracts(f.db, f.tenantId, f.owner);
    assert.deepEqual(contracts.map((c) => [c.revision, c.status]).sort(), [[1, 'SUPERSEDED'], [2, 'GENERATED']]);
    // Os dois PDFs continuam guardados.
    assert.equal((await listOrderDocuments(f.db, f.tenantId, f.owner)).filter((d) => d.type === 'CONTRATO_ORIGINAL').length, 2);
    const unitId = (await f.db.prepare('SELECT unit_id AS u FROM orders WHERE id = ?').bind(orderId).first<{ u: string }>())!.u;
    await updateOrder(f.db, f.tenantId, orderId, { customerId: f.customerId, unitId, total: 850000, purchaseDate: '2026-09-26', installments: 0, downPayment: 850000, downPaymentMethod: 'Dinheiro' }, f.seller, NOW);
    contracts = await listContracts(f.db, f.tenantId, f.owner);
    assert.ok(contracts.every((c) => c.status === 'SUPERSEDED'), 'dados mudaram: contrato anterior deixa de valer');
    const third = await generateContract(f.db, f.storage, f.tenantId, orderId, f.seller, NOW);
    assert.ok((await pdfText((await readDocument(f.db, f.storage, f.tenantId, third.documentId, f.seller)).bytes)).text.includes('À vista (Dinheiro)'));
    await cancelOrder(f.db, f.tenantId, orderId, 'Cliente desistiu', f.seller, NOW);
    assert.equal((await listContracts(f.db, f.tenantId, f.owner)).find((c) => c.id === third.contractId)?.status, 'CANCELLED');
    await assert.rejects(() => generateContract(f.db, f.storage, f.tenantId, orderId, f.seller, NOW), /cancelado/);
    // Contrato enviado para assinatura (etapa seguinte) trava alterações do pedido.
    const other = await motoOrder(f, f.dmax, 'CH-TRAVA');
    const c = await generateContract(f.db, f.storage, f.tenantId, other, f.seller, NOW);
    await f.db.prepare("UPDATE contracts SET internal_status = 'SENT' WHERE id = ?").bind(c.contractId).run();
    await assert.rejects(() => cancelOrder(f.db, f.tenantId, other, 'desistência', f.seller, NOW), /contrato enviado para assinatura/);
    await assert.rejects(() => generateContract(f.db, f.storage, f.tenantId, other, f.seller, NOW), /já tem contrato enviado/);
});

test('documentos: tipo pelo conteúdo, limite, acesso por loja, exclusão lógica só por admin e PDF de contrato vigente protegido', async () => {
    const f = await fixture();
    const orderId = await motoOrder(f);
    const pdf = new TextEncoder().encode('%PDF-1.4\n%fake minimal\n');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]); // "MZ": executável Windows
    assert.equal(detectFileType(pdf)?.mime, 'application/pdf');
    assert.equal(detectFileType(png)?.mime, 'image/png');
    assert.equal(detectFileType(exe), null);
    const id = await uploadOrderDocument(f.db, f.storage, f.tenantId, orderId, { description: 'RG do cliente', filename: '../../etc/passwd.pdf', bytes: pdf }, f.seller, NOW);
    await assert.rejects(() => uploadOrderDocument(f.db, f.storage, f.tenantId, orderId, { description: 'Programa', filename: 'nota.pdf', bytes: exe }, f.seller, NOW), /Tipo de arquivo não aceito/);
    await assert.rejects(() => uploadOrderDocument(f.db, f.storage, f.tenantId, orderId, { description: 'x', filename: 'a.pdf', bytes: pdf }, f.seller, NOW), /descrição/);
    await assert.rejects(() => uploadOrderDocument(f.db, f.storage, f.tenantId, orderId, { description: 'Grande', filename: 'a.pdf', bytes: new Uint8Array(10 * 1024 * 1024 + 1).fill(0x25) }, f.seller, NOW), /10 MB/);
    const read = await readDocument(f.db, f.storage, f.tenantId, id, f.seller);
    assert.deepEqual([...read.bytes], [...pdf]);
    assert.ok(!read.filename.includes('/') && read.filename.endsWith('.pdf'));
    const key = (await f.db.prepare('SELECT storage_key AS k FROM documents WHERE id = ?').bind(id).first<{ k: string }>())!.k;
    assert.match(key, new RegExp(`^t/${f.tenantId}/pedidos/${orderId}/[0-9a-f-]{36}\\.pdf$`), 'chave montada pelo servidor, sem o nome do usuário');
    assert.throws(() => assertSafeKey('t/../../etc/passwd'));

    // Vendedor restrito a outra loja não lê documento da D-MAX.
    const cellSellerId = await addMember(f.db, f.tenantId, { email: 'cell@teste.com', roleId: 'ROLE_VENDEDOR_ONLINE', name: 'Vendedora Cell', storeId: f.cell });
    const cellSeller = await actorFor(f.db, f.tenantId, cellSellerId, 'operator', 'Vendedora Cell', f.cell);
    await assert.rejects(() => readDocument(f.db, f.storage, f.tenantId, id, cellSeller), /outra loja/);
    assert.equal((await listOrderDocuments(f.db, f.tenantId, cellSeller)).length, 0);

    await assert.rejects(() => deleteDocument(f.db, f.tenantId, id, f.seller, NOW), /permissão/);
    await deleteDocument(f.db, f.tenantId, id, f.owner, NOW);
    await assert.rejects(() => readDocument(f.db, f.storage, f.tenantId, id, f.owner), /não encontrado/);
    assert.ok(await f.db.prepare('SELECT deleted_at FROM documents WHERE id = ?').bind(id).first(), 'exclusão lógica: o registro continua');
    const contract = await generateContract(f.db, f.storage, f.tenantId, orderId, f.seller, NOW);
    await assert.rejects(() => deleteDocument(f.db, f.tenantId, contract.documentId, f.owner, NOW), /contrato vigente/);

    assert.throws(() => storageFromEnv({}), /STORAGE_DIR/);
});

test('comandos contract.generate e document.delete pela API, com auditoria', async () => {
    const f = await fixture();
    const orderId = await motoOrder(f);
    const contractId = await dispatchCommand(f.db, f.tenantId, f.seller, plan, { type: 'contract.generate', orderId }, NOW, { storage: f.storage });
    assert.ok(contractId);
    const log = await f.db.prepare("SELECT description FROM audit_logs WHERE entity = 'order' AND entity_id = ? AND description LIKE 'Contrato gerado%'").bind(orderId).first<{ description: string }>();
    assert.equal(log?.description, 'Contrato gerado (pedido-1-contrato-moto-v1-r1)');
});
