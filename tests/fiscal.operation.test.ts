import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale } from '../lib/sales/service.ts';
import { saveFiscalStoreConfig, generateNFeForSale, getFiscalStoreConfig } from '../lib/fiscal/service.ts';
import { buildNFeXml, fiscalPaymentCode } from '../lib/fiscal/builder.ts';
import { resolveSaleOperation } from '../lib/fiscal/operation.ts';

const owner = { userId: 'owner-1', displayName: 'Titular', role: 'ADMIN', storeId: null, permissions: permissionsForRole('OWNER') };
const operator = { userId: 'op-1', displayName: 'Operador', role: 'OPERADOR_CAIXA', storeId: null, permissions: permissionsForRole('OPERADOR_CAIXA') };

async function fixture() {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id, name, state, revision, subscription_status, access_until, max_stores, created_at) VALUES ('t1', 'Conta', '{}', 0, 'trial', 9999999999999, 3, 0)").bind().run();
    const storeId = await createStore(db, 't1', { name: 'Loja Centro', legalName: 'LOJA CENTRO COMERCIO LTDA', cnpj: '12345678000190', ie: '123456789110', uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' }, owner);
    await saveFiscalStoreConfig(db, 't1', storeId, { series: 1, crt: '1_SIMPLES_NACIONAL', natureOfOperation: 'Venda de mercadoria' }, owner);
    const productId = await createProduct(db, 't1', { name: 'Refrigerante 350ml', sku: 'REFRI-350', price: 500, cost: 250, minimum: 5, unit: 'UN', ncm: '22021000', cfop: '5102', origin: '0', taxCode: '102' }, owner);
    await receiveStock(db, { tenantId: 't1', storeId, productId, quantity: 50, userId: owner.userId, reason: 'Estoque inicial' }, owner);
    const op = { ...operator, storeId };
    await openSession(db, 't1', storeId, 0, op);
    // Dados MOCK de teste: CPF de exemplo com dígitos válidos, nome fictício.
    const sell = (payment: string, customer = 'Cliente MOCK', document = '52998224725') =>
        createSale(db, 't1', { storeId, items: [{ productId, qty: 1 }], customer, document, payment } as never, op);
    const xmlOf = async (saleId: string) => (await db.prepare('SELECT raw_xml AS x FROM fiscal_documents WHERE sale_id = ?').bind(saleId).first<{ x: string }>())?.x ?? '';
    const issued = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM fiscal_documents').bind().first<{ n: number }>())?.n ?? 0);
    return { db, storeId, productId, op, sell, xmlOf, issued };
}

const ISSUER = { cnpj: '12345678000190', legalName: 'LOJA CENTRO LTDA', ie: '123456789110', crt: '1_SIMPLES_NACIONAL' as const, uf: 'SP', city: 'São Paulo', municipalityCode: '3550308', address: 'Av Paulista', number: '1000', district: 'Bela Vista', zip: '01310100' };
const ITEM = { code: 'P1', description: 'Produto', ncm: '22021000', cfop: '5102', unit: 'UN', qty: 1, unitPrice: 1000, totalPrice: 1000, origin: '0', taxCode: '102' };
const base = (over: Record<string, unknown> = {}) => ({ environment: 'homologacao' as const, series: 1, number: 1, emissionDate: new Date(Date.UTC(2026, 8, 28, 15)), issuer: ISSUER, items: [ITEM], payments: [{ method: 'Pix', amount: 1000 }], natureOfOperation: 'Venda de mercadoria', presence: '1' as const, ...over });

test('tPag: crédito 03, débito 04; "Cartão" sem o tipo bloqueia em vez de presumir crédito', () => {
    assert.equal(fiscalPaymentCode('Cartão de crédito'), '03');
    assert.equal(fiscalPaymentCode('Cartão de débito'), '04');
    assert.throws(() => fiscalPaymentCode('Cartão'), /crédito ou débito/);
    assert.throws(() => fiscalPaymentCode('Cheque'), /sem código fiscal/);
    const { xml } = buildNFeXml(base({ payments: [{ method: 'Cartão de débito', amount: 1000 }] }) as never);
    assert.match(xml, /<tPag>04<\/tPag>/);
});

test('montador: natureza da operação, número do endereço, regime e indPres sem valores padrão', () => {
    assert.throws(() => buildNFeXml(base({ natureOfOperation: '  ' }) as never), /natureza da operação/);
    assert.throws(() => buildNFeXml(base({ issuer: { ...ISSUER, number: '' } }) as never), /número do endereço/);
    assert.throws(() => buildNFeXml(base({ issuer: { ...ISSUER, crt: '' } }) as never), /regime tributário/);
    assert.throws(() => buildNFeXml(base({ presence: undefined }) as never), /atendimento/);
    assert.throws(() => buildNFeXml(base({ model: '65', presence: '2' }) as never), /internet não pode sair em NFC-e/);
    assert.throws(() => buildNFeXml(base({ recipient: { document: '52998224725', name: '' } }) as never), /nome do cliente/);
    const { xml } = buildNFeXml(base({ presence: '2', natureOfOperation: 'Venda de producao' }) as never);
    assert.match(xml, /<indPres>2<\/indPres>/);
    assert.match(xml, /<natOp>Venda de producao<\/natOp>/);
    assert.match(xml, /<nro>1000<\/nro>/);
});

test('forma de atendimento: PDV é presencial; pedido usa a forma informada; NFC-e pela internet e outro estado bloqueiam', async () => {
    // MOCK de banco: só devolve a linha do pedido consultada por resolveSaleOperation.
    const stub = (row: unknown) => ({ prepare: () => ({ bind: () => ({ first: async () => row }) }) }) as unknown as D1Database;
    assert.deepEqual(await resolveSaleOperation(stub(null), 't1', 's1', 'SP', '55'), { presence: '1' });
    assert.deepEqual(await resolveSaleOperation(stub({ number: 3, channel: 'PRESENCIAL', customerUf: '' }), 't1', 's1', 'SP', '65'), { presence: '1' });
    assert.deepEqual(await resolveSaleOperation(stub({ number: 3, channel: 'INTERNET', customerUf: 'sp' }), 't1', 's1', 'SP', '55'), { presence: '2' });
    assert.deepEqual(await resolveSaleOperation(stub({ number: 3, channel: 'ENTREGA', customerUf: 'SP' }), 't1', 's1', 'SP', '65'), { presence: '4' });
    await assert.rejects(() => resolveSaleOperation(stub({ number: 3, channel: '', customerUf: 'SP' }), 't1', 's1', 'SP', '55'), /não informa como o cliente comprou/);
    await assert.rejects(() => resolveSaleOperation(stub({ number: 3, channel: 'INTERNET', customerUf: 'SP' }), 't1', 's1', 'SP', '65'), /Emita NF-e/);
    await assert.rejects(() => resolveSaleOperation(stub({ number: 3, channel: 'ENTREGA', customerUf: '' }), 't1', 's1', 'SP', '55'), /UF do endereço do cliente/);
    await assert.rejects(() => resolveSaleOperation(stub({ number: 3, channel: 'INTERNET', customerUf: 'RJ' }), 't1', 's1', 'SP', '55'), /interestadual/);
});

test('NF-e: exige CPF/CNPJ e nome do cliente (sem CPF "00000000000"), natureza da operação e número da loja', async () => {
    const f = await fixture();
    await assert.rejects(async () => generateNFeForSale(f.db, 't1', await f.sell('Pix', '', ''), owner), /CPF ou CNPJ do cliente/);
    await assert.rejects(async () => generateNFeForSale(f.db, 't1', await f.sell('Pix', '', '52998224725'), owner), /nome do cliente/);
    const sale = await f.sell('Pix');
    await f.db.prepare("UPDATE fiscal_configurations SET nat_op = ''").bind().run();
    await assert.rejects(() => generateNFeForSale(f.db, 't1', sale, owner), /natureza da operação/);
    await f.db.prepare("UPDATE fiscal_configurations SET nat_op = 'Venda de mercadoria'").bind().run();
    await f.db.prepare("UPDATE stores SET number = ''").bind().run();
    await assert.rejects(() => generateNFeForSale(f.db, 't1', sale, owner), /número do endereço/);
    await f.db.prepare("UPDATE stores SET number = 'SN'").bind().run();
    assert.equal(await f.issued(), 0, 'nenhum documento criado nas tentativas bloqueadas');
    await generateNFeForSale(f.db, 't1', sale, owner);
    const xml = await f.xmlOf(sale);
    assert.match(xml, /<nro>SN<\/nro>/);
    assert.match(xml, /<indPres>1<\/indPres>/);
    assert.match(xml, /<CPF>52998224725<\/CPF>/);
    assert.doesNotMatch(xml, /00000000000/);
});

test('NF-e: venda antiga como "Cartão" bloqueia sem gastar número; com o tipo registrado sai tPag 04', async () => {
    const f = await fixture();
    const sale = await f.sell('Cartão');
    await assert.rejects(() => generateNFeForSale(f.db, 't1', sale, owner), /crédito ou débito/);
    assert.equal(await f.issued(), 0);
    await f.db.prepare("UPDATE sale_payments SET method = 'Cartão de débito' WHERE sale_id = ?").bind(sale).run();
    const doc = await generateNFeForSale(f.db, 't1', sale, owner);
    assert.equal(doc.number, 1, 'o número 1 não foi consumido pela tentativa bloqueada');
    assert.match(await f.xmlOf(sale), /<tPag>04<\/tPag>/);
});

test('configuração fiscal: sem regime presumido — loja sem configuração não aparece como "Simples Nacional"', async () => {
    const f = await fixture();
    const other = await createStore(f.db, 't1', { name: 'Loja 2' }, owner);
    const empty = await getFiscalStoreConfig(f.db, 't1', other, owner);
    assert.equal(empty.crt, null);
    assert.equal(empty.natureOfOperation, '');
    const saved = await getFiscalStoreConfig(f.db, 't1', f.storeId, owner);
    assert.equal(saved.crt, '1_SIMPLES_NACIONAL');
    assert.equal(saved.natureOfOperation, 'Venda de mercadoria');
    await assert.rejects(async () => saveFiscalStoreConfig(f.db, 't1', other, { series: 1, crt: '1_SIMPLES_NACIONAL' }, owner));
});
