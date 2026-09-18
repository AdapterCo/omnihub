import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore } from '../lib/catalog/service.ts';
import { assignTenantUser, listTenantUsers, removeTenantUser } from '../lib/users/service.ts';

const owner = { userId: 'owner-1', displayName: 'Dona', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };
const operator = { userId: 'op-1', displayName: 'Operador', role: 'operator', storeId: null, permissions: permissionsForRole('OPERADOR_CAIXA') };

test('assignTenantUser cria membro, papel e sincroniza com memberships', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();
    const storeId = await createStore(db, 't1', { name: 'Loja Centro' }, owner);

    // Atribuição de novo usuário
    await assignTenantUser(db, 't1', {
        userId: 'usr-new',
        displayName: 'Novo Operador',
        role: 'OPERADOR_CAIXA',
        storeId,
    }, owner);

    const members = await listTenantUsers(db, 't1', owner);
    assert.equal(members.length, 1);
    assert.equal(members[0]?.id, 'usr-new');
    assert.equal(members[0]?.displayName, 'Novo Operador');
    assert.equal(members[0]?.role, 'OPERADOR_CAIXA');
    assert.equal(members[0]?.storeId, storeId);
    assert.equal(members[0]?.storeName, 'Loja Centro');

    // Confere sincronização na tabela legada memberships
    const mem = await db.prepare('SELECT user_id, account_id, role, store_id FROM memberships WHERE user_id = ?').bind('usr-new').first<{ user_id: string; account_id: string; role: string; store_id: string }>();
    assert.ok(mem);
    assert.equal(mem.role, 'operator');
    assert.equal(mem.store_id, storeId);
});

test('assignTenantUser não permite atribuir papel OWNER diretamente', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();

    await assert.rejects(
        () => assignTenantUser(db, 't1', { userId: 'usr-2', displayName: 'Outro', role: 'OWNER' as never }, owner),
        /Não é permitido atribuir o papel OWNER/,
    );
});

test('Operador de caixa sem USER_CREATE / USER_VIEW não pode gerenciar equipe', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();

    await assert.rejects(
        () => listTenantUsers(db, 't1', operator),
        /Você não tem permissão para realizar esta operação/,
    );

    await assert.rejects(
        () => assignTenantUser(db, 't1', { userId: 'usr-2', displayName: 'Outro', role: 'ESTOQUISTA' }, operator),
        /Você não tem permissão para realizar esta operação/,
    );
});

test('removeTenantUser remove vínculos e impede remover a si próprio ou o OWNER', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();

    await assignTenantUser(db, 't1', { userId: 'usr-sub', displayName: 'Subordinado', role: 'GERENTE' }, owner);

    // Não pode remover a si próprio
    await assert.rejects(
        () => removeTenantUser(db, 't1', owner.userId, owner),
        /Você não pode remover seu próprio acesso/,
    );

    // Remove com sucesso
    await removeTenantUser(db, 't1', 'usr-sub', owner);
    const membersAfter = await listTenantUsers(db, 't1', owner);
    assert.equal(membersAfter.length, 0);
});

test('Isolamento de equipe entre tenants: membros do tenant A não aparecem no tenant B', async () => {
    const db = createFakeD1();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t1','Tenant 1','{}',0,'trial',9999999999999,3,0)").bind().run();
    await db.prepare("INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES ('t2','Tenant 2','{}',0,'trial',9999999999999,3,0)").bind().run();

    await assignTenantUser(db, 't1', { userId: 'usr-t1', displayName: 'Membro T1', role: 'ESTOQUISTA' }, owner);

    const membersT1 = await listTenantUsers(db, 't1', owner);
    const membersT2 = await listTenantUsers(db, 't2', owner);

    assert.equal(membersT1.length, 1);
    assert.equal(membersT2.length, 0);
});
