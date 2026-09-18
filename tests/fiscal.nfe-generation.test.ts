import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore, createProduct } from '../lib/catalog/service.ts';
import { openSession } from '../lib/cash/service.ts';
import { receiveStock } from '../lib/inventory/service.ts';
import { createSale, cancelSale } from '../lib/sales/service.ts';
import {
    saveFiscalStoreConfig,
    generateNFeForSale,
    getNFeDocumentBySaleId,
    listFiscalDocumentsForSnapshot,
} from '../lib/fiscal/service.ts';
import { validateNFeXmlSchema } from '../lib/fiscal/validator.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';

const owner = {
    userId: 'owner-1',
    displayName: 'Titular',
    role: 'ADMIN',
    storeId: null,
    permissions: permissionsForRole('OWNER'),
};

const operator = {
    userId: 'op-1',
    displayName: 'Operador',
    role: 'OPERADOR_CAIXA',
    storeId: null,
    permissions: permissionsForRole('OPERADOR_CAIXA'),
};

const plan = { status: 'active', accessUntil: Date.now() + 100000, maxStores: 3 };

async function setupFiscalFixture() {
    const db = createFakeD1();
    await db
        .prepare(
            "INSERT INTO accounts (id, name, state, revision, subscription_status, access_until, max_stores, created_at) VALUES ('t1', 'Tenant Matriz', '{}', 0, 'trial', 9999999999999, 3, 0)",
        )
        .bind()
        .run();

    const storeId = await createStore(
        db,
        't1',
        {
            name: 'Loja Centro',
            legalName: 'LOJA CENTRO COMERCIO LTDA',
            cnpj: '12345678000190',
            ie: '123456789110',
            uf: 'SP',
            city: 'São Paulo',
            municipalityCode: '3550308',
            address: 'Av Paulista',
            number: '1000',
            district: 'Bela Vista',
            zip: '01310100',
        },
        owner,
    );

    await saveFiscalStoreConfig(db, 't1', storeId, { series: 1, crt: '1_SIMPLES_NACIONAL' }, owner);

    const productId = await createProduct(
        db,
        't1',
        {
            name: 'Refrigerante 350ml',
            sku: 'REFRI-350',
            price: 500, // R$ 5,00
            cost: 250,
            minimum: 5,
            unit: 'UN',
            ncm: '22021000',
            cfop: '5102',
            origin: '0',
            taxCode: '102',
        },
        owner,
    );

    await receiveStock(
        db,
        {
            tenantId: 't1',
            storeId,
            productId,
            quantity: 50,
            userId: owner.userId,
            reason: 'Estoque inicial',
        },
        owner,
    );

    const op = { ...operator, storeId };
    await openSession(db, 't1', storeId, 0, op);

    return { db, storeId, productId, op };
}

test('Validador XSD / Schema SEFAZ (MOC 7.00 / PL_009k): rejeita XML inválido e aprova XML correto', () => {
    // 1. XML vazio ou inválido sintaticamente
    const resEmpty = validateNFeXmlSchema('');
    assert.equal(resEmpty.valid, false);
    assert.ok(resEmpty.errors.some((e) => e.message.includes('não fornecido') || e.message.includes('em branco')));

    // 2. XML sem tag raiz NFe
    const resNoRoot = validateNFeXmlSchema('<outroDocumento><infNFe/></outroDocumento>');
    assert.equal(resNoRoot.valid, false);
    assert.ok(resNoRoot.errors.some((e) => e.message.includes('<NFe>')));

    // 3. XML com divergência matemática nos totais
    const invalidTotalsXml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe35260912345678000190550010000000011000000017" versao="4.00">
    <ide>
      <cUF>35</cUF>
      <cNF>00000001</cNF>
      <natOp>VENDA MERCADORIA</natOp>
      <mod>55</mod>
      <serie>1</serie>
      <nNF>1</nNF>
      <dhEmi>2026-09-17T00:00:00-03:00</dhEmi>
      <tpNF>1</tpNF>
      <idDest>1</idDest>
      <cMunFG>3550308</cMunFG>
      <tpImp>1</tpImp>
      <tpEmis>1</tpEmis>
      <cDV>7</cDV>
      <tpAmb>2</tpAmb>
      <finNFe>1</finNFe>
      <indFinal>1</indFinal>
      <indPres>1</indPres>
      <procEmi>0</procEmi>
      <verProc>1.0</verProc>
    </ide>
    <emit>
      <CNPJ>12345678000190</CNPJ>
      <xNome>EMPRESA TESTE</xNome>
      <enderEmit>
        <xLgr>RUA TESTE</xLgr>
        <nro>100</nro>
        <xBairro>CENTRO</xBairro>
        <cMun>3550308</cMun>
        <xMun>SAO PAULO</xMun>
        <UF>SP</UF>
        <CEP>01310100</CEP>
      </enderEmit>
      <IE>123456789110</IE>
      <CRT>1</CRT>
    </emit>
    <dest>
      <CPF>00000000000</CPF>
      <xNome>NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xNome>
      <indIEDest>9</indIEDest>
    </dest>
    <det nItem="1">
      <prod>
        <cProd>PROD-1</cProd>
        <cEAN>SEM GTIN</cEAN>
        <xProd>PRODUTO TESTE</xProd>
        <NCM>22021000</NCM>
        <CFOP>5102</CFOP>
        <uCom>UN</uCom>
        <qCom>1.0000</qCom>
        <vUnCom>10.0000</vUnCom>
        <vProd>10.00</vProd>
        <cEANTrib>SEM GTIN</cEANTrib>
        <uTrib>UN</uTrib>
        <qTrib>1.0000</qTrib>
        <vUnTrib>10.0000</vUnTrib>
        <indTot>1</indTot>
      </prod>
      <imposto>
        <ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>
        <PIS><PISNT><CST>07</CST></PISNT></PIS>
        <COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>
      </imposto>
    </det>
    <total>
      <ICMSTot>
        <vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>10.00</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro>
        <vNF>15.00</vNF>
      </ICMSTot>
    </total>
    <transp><modFrete>9</modFrete></transp>
    <pag><detPag><tPag>01</tPag><vPag>10.00</vPag></detPag></pag>
  </infNFe>
</NFe>`;
    const resTotals = validateNFeXmlSchema(invalidTotalsXml);
    assert.equal(resTotals.valid, false);
    assert.ok(resTotals.errors.some((e) => e.message.includes('vNF')));
});

test('Geração completa de NF-e Modelo 55 a partir de venda: gera XML 4.00, valida schema e grava com status GENERATED', async () => {
    const { db, storeId, productId, op } = await setupFiscalFixture();

    const saleId = await createSale(
        db,
        't1',
        {
            storeId,
            items: [{ productId, qty: 2 }],
            customer: 'Cliente Homologação',
            document: '12345678909',
            payment: 'Dinheiro',
        },
        op,
    );
    assert.ok(saleId);

    // Geração da NF-e via comando fiscal.nfe.generate
    const result = await dispatchCommand(
        db,
        't1',
        owner,
        plan,
        { type: 'fiscal.nfe.generate', saleId },
    );
    assert.ok(result);

    const doc = await getNFeDocumentBySaleId(db, 't1', saleId, owner);
    assert.ok(doc);
    assert.equal(doc.saleId, saleId);
    assert.equal(doc.model, '55');
    assert.equal(doc.series, 1);
    assert.equal(doc.number, 1);
    assert.equal(doc.status, 'GENERATED');
    assert.ok(doc.rawXml);
    assert.equal(doc.rawXml.includes('xmlns="http://www.portalfiscal.inf.br/nfe"'), true);
    assert.equal(doc.rawXml.includes('<tpAmb>2</tpAmb>'), true); // Estritamente Homologação

    // Validação formal de Schema XSD
    const validation = validateNFeXmlSchema(doc.rawXml);
    assert.equal(validation.valid, true, `Erros de validação: ${validation.errors.map((e) => e.message).join('; ')}`);
    assert.equal(validation.errors.length, 0);

    // Chave de acesso: 44 dígitos
    assert.equal(doc.accessKey.length, 44);
    assert.equal(doc.accessKey.startsWith('35'), true); // SP
});

test('Numeração sequencial e atômica da NF-e por loja e série', async () => {
    const { db, storeId, productId, op } = await setupFiscalFixture();

    // Venda 1
    const sale1 = await createSale(
        db,
        't1',
        { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' },
        op,
    );
    const doc1 = await generateNFeForSale(db, 't1', sale1, owner);
    assert.equal(doc1.number, 1);

    // Venda 2
    const sale2 = await createSale(
        db,
        't1',
        { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Pix' },
        op,
    );
    const doc2 = await generateNFeForSale(db, 't1', sale2, owner);
    assert.equal(doc2.number, 2);
    assert.notEqual(doc1.accessKey, doc2.accessKey);
});

test('Impede duplicidade de emissão de NF-e para a mesma venda', async () => {
    const { db, storeId, productId, op } = await setupFiscalFixture();

    const saleId = await createSale(
        db,
        't1',
        { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' },
        op,
    );

    await generateNFeForSale(db, 't1', saleId, owner);

    // Segunda tentativa para a mesma venda deve falhar com erro 409
    await assert.rejects(
        () => generateNFeForSale(db, 't1', saleId, owner),
        /já possui documento fiscal emitido ou gerado/,
    );
});

test('Rejeita emissão para venda cancelada', async () => {
    const { db, storeId, productId, op } = await setupFiscalFixture();

    const saleId = await createSale(
        db,
        't1',
        { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' },
        op,
    );

    await cancelSale(db, 't1', saleId, owner);

    await assert.rejects(
        () => generateNFeForSale(db, 't1', saleId, owner),
        /Não é possível emitir NF-e para uma venda cancelada/,
    );
});

test('Rejeita geração se dados cadastrais obrigatórios da loja estiverem ausentes (sem inventar dados)', async () => {
    const db = createFakeD1();
    await db
        .prepare(
            "INSERT INTO accounts (id, name, state, revision, subscription_status, access_until, max_stores, created_at) VALUES ('t2', 'Tenant Incompleto', '{}', 0, 'trial', 9999999999999, 3, 0)",
        )
        .bind()
        .run();

    // Loja sem CNPJ e sem UF
    const storeId = await createStore(
        db,
        't2',
        {
            name: 'Loja Sem Dados Fiscais',
        },
        owner,
    );

    const productId = await createProduct(
        db,
        't2',
        {
            name: 'Produto Teste',
            sku: 'PRD-1',
            price: 1000,
            cost: 500,
            minimum: 1,
            unit: 'UN',
            ncm: '22021000',
        },
        owner,
    );

    await receiveStock(
        db,
        { tenantId: 't2', storeId, productId, quantity: 10, userId: owner.userId, reason: 'Entrada' },
        owner,
    );

    const op = { ...operator, storeId };
    await openSession(db, 't2', storeId, 0, op);
    const saleId = await createSale(
        db,
        't2',
        { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' },
        op,
    );

    await assert.rejects(
        () => generateNFeForSale(db, 't2', saleId, owner),
        /CNPJ válido com 14 dígitos/,
    );
});

test('Rejeita geração se a loja não tiver configuração fiscal salva (nunca presume regime tributário, §37)', async () => {
    const db = createFakeD1();
    await db
        .prepare(
            "INSERT INTO accounts (id, name, state, revision, subscription_status, access_until, max_stores, created_at) VALUES ('t3', 'Tenant Sem Config Fiscal', '{}', 0, 'trial', 9999999999999, 3, 0)",
        )
        .bind()
        .run();

    // Loja com todos os dados cadastrais completos, mas SEM fiscal.config.save (sem CRT/série escolhidos)
    const storeId = await createStore(
        db,
        't3',
        {
            name: 'Loja Completa Sem Config Fiscal',
            legalName: 'LOJA COMPLETA LTDA',
            cnpj: '12345678000190',
            ie: '123456789110',
            uf: 'SP',
            city: 'São Paulo',
            municipalityCode: '3550308',
            address: 'Av Paulista',
            number: '1000',
            district: 'Bela Vista',
            zip: '01310100',
        },
        owner,
    );

    const productId = await createProduct(
        db,
        't3',
        { name: 'Produto Teste', sku: 'PRD-2', price: 1000, cost: 500, minimum: 1, unit: 'UN', ncm: '22021000', cfop: '5102', origin: '0', taxCode: '102' },
        owner,
    );

    await receiveStock(db, { tenantId: 't3', storeId, productId, quantity: 10, userId: owner.userId, reason: 'Entrada' }, owner);

    const op = { ...operator, storeId };
    await openSession(db, 't3', storeId, 0, op);
    const saleId = await createSale(db, 't3', { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' }, op);

    await assert.rejects(
        () => generateNFeForSale(db, 't3', saleId, owner),
        /Configure o regime tributário/,
    );
});

test('Rejeita geração se produto não possuir NCM válido de 8 dígitos', async () => {
    const { db, storeId, op } = await setupFiscalFixture();

    const productWithoutNcm = await createProduct(
        db,
        't1',
        {
            name: 'Produto Sem NCM',
            sku: 'SEM-NCM',
            price: 1000,
            cost: 500,
            minimum: 1,
            unit: 'UN',
        },
        owner,
    );

    await receiveStock(
        db,
        {
            tenantId: 't1',
            storeId,
            productId: productWithoutNcm,
            quantity: 10,
            userId: owner.userId,
            reason: 'Entrada',
        },
        owner,
    );

    const saleId = await createSale(
        db,
        't1',
        {
            storeId,
            items: [{ productId: productWithoutNcm, qty: 1 }],
            customer: '',
            document: '',
            payment: 'Dinheiro',
        },
        op,
    );

    await assert.rejects(
        () => generateNFeForSale(db, 't1', saleId, owner),
        /NCM válido de 8 dígitos/,
    );
});

test('Rejeita geração se produto não possuir CFOP cadastrado (nunca presume "5102" ou qualquer outro padrão)', async () => {
    const { db, storeId, op } = await setupFiscalFixture();

    const productWithoutCfop = await createProduct(
        db,
        't1',
        {
            name: 'Produto Sem CFOP',
            sku: 'SEM-CFOP',
            price: 1000,
            cost: 500,
            minimum: 1,
            unit: 'UN',
            ncm: '22021000',
        },
        owner,
    );

    await receiveStock(
        db,
        {
            tenantId: 't1',
            storeId,
            productId: productWithoutCfop,
            quantity: 10,
            userId: owner.userId,
            reason: 'Entrada',
        },
        owner,
    );

    const saleId = await createSale(
        db,
        't1',
        {
            storeId,
            items: [{ productId: productWithoutCfop, qty: 1 }],
            customer: '',
            document: '',
            payment: 'Dinheiro',
        },
        op,
    );

    await assert.rejects(
        () => generateNFeForSale(db, 't1', saleId, owner),
        /CFOP válido de 4 dígitos/,
    );
});

test('Isolamento multitenant: operador de outro tenant não consegue gerar NF-e', async () => {
    const { db, storeId, productId, op } = await setupFiscalFixture();

    const saleId = await createSale(
        db,
        't1',
        { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' },
        op,
    );

    const intruder = {
        userId: 'intruder-1',
        displayName: 'Invasor',
        role: 'ADMIN',
        storeId: null,
        permissions: permissionsForRole('OWNER'),
    };

    await assert.rejects(
        () => generateNFeForSale(db, 'outro-tenant', saleId, intruder),
        /Venda não encontrada/,
    );
});

test('listFiscalDocumentsForSnapshot retorna documentos fiscais mapeados por saleId', async () => {
    const { db, storeId, productId, op } = await setupFiscalFixture();

    const saleId = await createSale(
        db,
        't1',
        { storeId, items: [{ productId, qty: 1 }], customer: '', document: '', payment: 'Dinheiro' },
        op,
    );

    await generateNFeForSale(db, 't1', saleId, owner);

    const snapshotDocs = await listFiscalDocumentsForSnapshot(db, 't1', owner);
    assert.ok(snapshotDocs[saleId]);
    assert.equal(snapshotDocs[saleId].saleId, saleId);
    assert.equal(snapshotDocs[saleId].status, 'GENERATED');
    assert.equal(snapshotDocs[saleId].number, 1);
    assert.ok(snapshotDocs[saleId].rawXml);
});
