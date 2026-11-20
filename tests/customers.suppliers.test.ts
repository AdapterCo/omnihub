import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import {
    createCustomer,
    updateCustomer,
    getCustomer,
    listCustomers,
    createSupplier,
    updateSupplier,
    getSupplier,
    listSuppliers,
    searchCustomers,
} from '../lib/customers/service.ts';
import { dispatchCommand } from '../lib/relationalCommands.ts';
import type { Entitlement } from '../lib/domain.ts';

const plan: Entitlement = { status: 'active', accessUntil: 9999999999999, maxStores: 5 };

const owner = { userId: 'owner-1', displayName: 'Proprietário', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };
const cashier = { userId: 'op-1', displayName: 'Caixa', role: 'operator', storeId: null, permissions: permissionsForRole('OPERADOR_CAIXA') };
const viewerOnly = { userId: 'view-1', displayName: 'Consulta', role: 'operator', storeId: null, permissions: permissionsForRole('CONSULTA') };

test('createCustomer e listCustomers com isolamento por tenant', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t2','Tenant 2','{}',0,'trial',9999999999999,3,0)").bind().run();

    // Cria cliente no tenant 1
    const cust1Id = await createCustomer(db, 't1', {
        name: 'Maria Oliveira',
        document: '123.456.789-00',
        docType: 'CPF',
        email: 'maria@example.com',
        phone: '11999999999',
        city: 'São Paulo',
        state: 'SP',
    }, owner);

    assert.ok(cust1Id);

    // Mesma pessoa/documento pode ser cadastrado no tenant 2 (isolamento multi-tenant)
    const cust2Id = await createCustomer(db, 't2', {
        name: 'Maria Oliveira',
        document: '12345678900',
        docType: 'CPF',
        city: 'São Paulo',
        state: 'SP',
    }, owner);

    assert.ok(cust2Id);
    assert.notEqual(cust1Id, cust2Id);

    // Listagem por tenant
    const t1List = await listCustomers(db, 't1', owner);
    assert.equal(t1List.length, 1);
    assert.equal(t1List[0]?.id, cust1Id);
    assert.equal(t1List[0]?.document, '12345678900'); // Limpeza de caracteres não numéricos

    const t2List = await listCustomers(db, 't2', owner);
    assert.equal(t2List.length, 1);
    assert.equal(t2List[0]?.id, cust2Id);

    // Tentativa de duplicar documento dentro do mesmo tenant deve falhar
    await assert.rejects(
        () => createCustomer(db, 't1', {
            name: 'Outra Maria',
            document: '12345678900',
        }, owner),
        /já está cadastrado para o cliente "Maria Oliveira"/,
    );
});

test('updateCustomer atualiza dados e valida unicidade', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();

    const c1 = await createCustomer(db, 't1', { name: 'Cliente Um', document: '11111111111' }, owner);
    const c2 = await createCustomer(db, 't1', { name: 'Cliente Dois', document: '22222222222' }, owner);

    // Atualização normal de c1
    await updateCustomer(db, 't1', c1, {
        name: 'Cliente Um Atualizado',
        email: 'cliente1@novo.com',
        city: 'Campinas',
        state: 'SP',
    }, owner);

    const updated = await getCustomer(db, 't1', c1, owner);
    assert.equal(updated?.name, 'Cliente Um Atualizado');
    assert.equal(updated?.email, 'cliente1@novo.com');
    assert.equal(updated?.city, 'Campinas');

    // Tentativa de atualizar documento de c2 para o mesmo de c1 deve falhar
    await assert.rejects(
        () => updateCustomer(db, 't1', c2, { document: '11111111111' }, owner),
        /já está cadastrado para outro cliente/,
    );
});

test('Operador de Caixa pode cadastrar e visualizar clientes mas não fornecedores', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();

    // Caixa pode criar cliente no PDV
    const custId = await createCustomer(db, 't1', {
        name: 'Cliente Balcão',
        document: '33333333333',
    }, cashier);
    assert.ok(custId);

    // Caixa pode listar clientes
    const list = await listCustomers(db, 't1', cashier);
    assert.equal(list.length, 1);

    // Mas Caixa não tem permissão para gerenciar fornecedores
    await assert.rejects(
        () => createSupplier(db, 't1', { name: 'Fornecedor X', document: '12345678000199' }, cashier),
        /Você não tem permissão para realizar esta operação/,
    );
});

test('createSupplier, updateSupplier e listSuppliers', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();

    const supId = await createSupplier(db, 't1', {
        name: 'Distribuidora ABC Ltda',
        tradeName: 'ABC Distribuição',
        document: '12.345.678/0001-90',
        ie: '123456789',
        contactName: 'Carlos Silva',
        email: 'contato@abc.com',
        phone: '1133334444',
        city: 'Santos',
        state: 'sp',
    }, owner);

    assert.ok(supId);

    const sup = await getSupplier(db, 't1', supId, owner);
    assert.equal(sup?.name, 'Distribuidora ABC Ltda');
    assert.equal(sup?.tradeName, 'ABC Distribuição');
    assert.equal(sup?.document, '12345678000190');
    assert.equal(sup?.state, 'SP'); // UF em maiúsculo

    // Unicidade de CNPJ
    await assert.rejects(
        () => createSupplier(db, 't1', {
            name: 'Outra Empresa',
            document: '12345678000190',
        }, owner),
        /Já existe um fornecedor cadastrado com este documento/,
    );

    // Atualização
    await updateSupplier(db, 't1', supId, {
        tradeName: 'ABC Logística Avançada',
    }, owner);

    const supUpdated = await getSupplier(db, 't1', supId, owner);
    assert.equal(supUpdated?.tradeName, 'ABC Logística Avançada');
});

test('dispatchCommand despacha customer.* e supplier.* e gera auditoria', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();

    // customer.create via dispatcher
    const custId = await dispatchCommand(db, 't1', owner, plan, {
        type: 'customer.create',
        data: {
            name: 'Cliente Comando',
            document: '44444444444',
        },
    });

    assert.ok(custId);

    // supplier.create via dispatcher
    const supId = await dispatchCommand(db, 't1', owner, plan, {
        type: 'supplier.create',
        data: {
            name: 'Fornecedor Comando',
            document: '99888777000166',
        },
    });

    assert.ok(supId);

    // Verifica auditoria gravada
    const audits = await db.prepare('SELECT description FROM audit_logs WHERE tenant_id = ? ORDER BY created_at ASC').bind('t1').all<{ description: string }>();
    assert.equal(audits.results.length, 2);
    assert.match(audits.results[0]?.description ?? '', /Cliente: Cliente Comando/);
    assert.match(audits.results[1]?.description ?? '', /Fornecedor: Fornecedor Comando/);
});

test('lista de clientes traz todos (antes parava no 100º nome e o cliente "sumia" do pedido)', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();
    // 150 clientes fictícios; os que começam com "Z" ficariam depois do 100º em ordem alfabética.
    for (let i = 0; i < 150; i++) {
        await createCustomer(db, 't1', { name: `${i < 140 ? 'Cliente' : 'Zé Fictício'} ${String(i).padStart(3, '0')}`, document: String(10000000000 + i) }, owner);
    }
    const all = await listCustomers(db, 't1', owner);
    assert.equal(all.length, 150);
    assert.ok(all.some((c) => c.name === 'Zé Fictício 149'), 'o último em ordem alfabética aparece');
    // A busca por termo continua limitada (não é usada pela tela).
    assert.ok((await listCustomers(db, 't1', owner, 'Cliente')).length <= 100);
});

test('busca de clientes no servidor: só a conta, sem acento, CPF/telefone com ou sem pontuação, várias palavras e páginas', async () => {
    const db = createFakeD1();
    for (const t of ['t1', 't2']) await db.prepare(`INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('${t}','${t}','{}',0,'trial',9999999999999,3,0)`).bind().run();
    // Dados fictícios.
    await createCustomer(db, 't1', { name: 'João da Silva', document: '529.982.247-25', phone: '(24) 99999-1234', city: 'Volta Redonda' }, owner);
    await createCustomer(db, 't1', { name: 'Maria Souza', document: '11144477735', email: 'maria@exemplo.com' }, owner);
    await createCustomer(db, 't2', { name: 'João de Outra Conta', document: '52998224725' }, owner);
    const names = async (tenant: string, q: string) => (await searchCustomers(db, tenant, owner, { q })).items.map((c) => c.name);
    // Só a conta: a outra conta tem um "João" com o mesmo CPF e nunca aparece.
    assert.deepEqual(await names('t1', 'joao'), ['João da Silva']);
    assert.deepEqual(await names('t2', 'joao'), ['João de Outra Conta']);
    assert.deepEqual(await names('t1', '529.982.247-25'), ['João da Silva']);
    assert.deepEqual(await names('t1', '52998224725'), ['João da Silva']);
    assert.deepEqual(await names('t1', '99999-1234'), ['João da Silva']);
    assert.deepEqual(await names('t1', 'MARIA exemplo'), ['Maria Souza']);
    assert.deepEqual(await names('t1', 'volta redonda'), ['João da Silva']);
    assert.deepEqual(await names('t1', 'joao maria'), []);
    // "%" e "_" são texto, não curinga.
    assert.deepEqual(await names('t1', '%'), []);
    assert.deepEqual(await names('t1', '_'), []);
    // Sem termo: todos da conta, em ordem.
    assert.deepEqual(await names('t1', ''), ['João da Silva', 'Maria Souza']);
    // Edição atualiza o texto de busca.
    const maria = (await searchCustomers(db, 't1', owner, { q: 'maria' })).items[0];
    await updateCustomer(db, 't1', maria.id, { name: 'Maria Aparecida' }, owner);
    assert.deepEqual(await names('t1', 'aparecida'), ['Maria Aparecida']);
    // Permissão: sem CUSTOMER_VIEW não busca.
    const stock = { userId: 'e-1', displayName: 'Estoque', role: 'operator', storeId: null, permissions: permissionsForRole('ESTOQUISTA') };
    await assert.rejects(() => searchCustomers(db, 't1', stock, { q: 'joao' }), /permissão/);
});

test('busca de clientes: páginas para contas grandes e clientes antigos sem o texto de busca', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','t1','{}',0,'trial',9999999999999,3,0)").bind().run();
    for (let i = 0; i < 45; i++) await createCustomer(db, 't1', { name: `Cliente ${String(i).padStart(2, '0')}`, document: String(20000000000 + i) }, owner);
    const p1 = await searchCustomers(db, 't1', owner, { q: 'cliente', limit: 20 });
    const p3 = await searchCustomers(db, 't1', owner, { q: 'cliente', limit: 20, offset: 40 });
    assert.equal(p1.items.length, 20);
    assert.equal(p1.hasMore, true);
    assert.equal(p3.items.length, 5);
    assert.equal(p3.hasMore, false);
    // Cliente gravado antes da coluna de busca existir (texto vazio): é preenchido na primeira busca.
    await db.prepare("INSERT INTO customers (id, tenant_id, name, document, created_at, updated_at) VALUES ('antigo', 't1', 'Zuleide Antiga', '33322211100', 0, 0)").bind().run();
    assert.deepEqual((await searchCustomers(db, 't1', owner, { q: 'zuleide' })).items.map((c) => c.id), ['antigo']);
    assert.deepEqual((await searchCustomers(db, 't1', owner, { q: '33322211100' })).items.map((c) => c.id), ['antigo']);
});
