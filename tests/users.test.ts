import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { permissionsForRole } from '../lib/authz/roles.ts';
import { createStore } from '../lib/catalog/service.ts';
import { assignTenantUser, createTenantUser, listTenantUsers, removeTenantUser, setTenantUserCredentials } from '../lib/users/service.ts';
import { registerAccount, loginWithPassword, getSessionUser } from '../lib/auth/service.ts';

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

test('createTenantUser cria membro com login próprio: o membro consegue entrar e cai na conta certa', async () => {
    const db = createFakeD1();
    const reg = await registerAccount(db, { accountName: 'Loja', displayName: 'Dona', email: 'dona@exemplo.com', password: 'senha-forte-1' });
    const dona = { userId: reg.userId, displayName: 'Dona', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };
    const id = await createTenantUser(db, reg.accountId, { displayName: 'Caixa Um', email: 'Caixa@Exemplo.com', password: 'senha-caixa-1', role: 'OPERADOR_CAIXA' }, dona);

    const session = await loginWithPassword(db, 'caixa@exemplo.com', 'senha-caixa-1');
    const user = await getSessionUser(db, session.token);
    assert.equal(user?.userId, id);
    const mem = await db.prepare('SELECT account_id AS accountId FROM memberships WHERE user_id = ?').bind(id).first<{ accountId: string }>();
    assert.equal(mem?.accountId, reg.accountId);
    const [listed] = (await listTenantUsers(db, reg.accountId, dona)).filter((m) => m.id === id);
    assert.equal(listed?.email, 'caixa@exemplo.com');
    assert.equal(listed?.hasLogin, true);

    await assert.rejects(() => createTenantUser(db, reg.accountId, { displayName: 'Outro', email: 'caixa@exemplo.com', password: 'senha-caixa-2', role: 'CONSULTA' }, dona), /já está em uso/);
    await assert.rejects(() => createTenantUser(db, reg.accountId, { displayName: 'Curta', email: 'curta@exemplo.com', password: '123', role: 'CONSULTA' }, dona), /ao menos 8/);
    await assert.rejects(() => createTenantUser(db, reg.accountId, { displayName: 'Op', email: 'op@exemplo.com', password: 'senha-op-123', role: 'CONSULTA' }, operator), /permissão/);
    // Falha no vínculo (papel OWNER) não deixa usuário órfão com o e-mail preso.
    await assert.rejects(() => createTenantUser(db, reg.accountId, { displayName: 'Dono 2', email: 'dono2@exemplo.com', password: 'senha-dono-2', role: 'OWNER' as never }, dona), /OWNER/);
    assert.equal(await db.prepare('SELECT id FROM users WHERE email = ?').bind('dono2@exemplo.com').first(), null);
});

test('setTenantUserCredentials dá acesso a membro antigo sem login, derruba sessões e protege OWNER/ADMIN', async () => {
    const db = createFakeD1();
    const reg = await registerAccount(db, { accountName: 'Loja', displayName: 'Dona', email: 'dona@exemplo.com', password: 'senha-forte-1' });
    const dona = { userId: reg.userId, displayName: 'Dona', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };
    // Membro criado do jeito antigo (só ID, sem e-mail/senha).
    await assignTenantUser(db, reg.accountId, { userId: 'usr-antigo', displayName: 'Antigo', role: 'GERENTE' }, dona);
    assert.equal((await listTenantUsers(db, reg.accountId, dona)).find((m) => m.id === 'usr-antigo')?.hasLogin, false);

    await setTenantUserCredentials(db, reg.accountId, { userId: 'usr-antigo', email: 'antigo@exemplo.com', password: 'senha-antiga-1' }, dona);
    const s1 = await loginWithPassword(db, 'antigo@exemplo.com', 'senha-antiga-1');
    await setTenantUserCredentials(db, reg.accountId, { userId: 'usr-antigo', email: 'antigo@exemplo.com', password: 'senha-nova-22' }, dona);
    assert.equal(await getSessionUser(db, s1.token), null, 'sessão antiga deve cair ao trocar a senha');
    await assert.rejects(() => loginWithPassword(db, 'antigo@exemplo.com', 'senha-antiga-1'), /inválidos/);
    await loginWithPassword(db, 'antigo@exemplo.com', 'senha-nova-22');

    // OWNER não pode ter credenciais trocadas por outro usuário; ADMIN só pelo OWNER.
    const adminId = await createTenantUser(db, reg.accountId, { displayName: 'Admin', email: 'admin@exemplo.com', password: 'senha-admin-1', role: 'ADMIN' }, dona);
    const admin = { userId: adminId, displayName: 'Admin', role: 'admin', storeId: null, permissions: permissionsForRole('ADMIN') };
    await assert.rejects(() => setTenantUserCredentials(db, reg.accountId, { userId: reg.userId, email: 'x@exemplo.com', password: 'senha-xxxx-1' }, admin), /proprietário/);
    const admin2 = await createTenantUser(db, reg.accountId, { displayName: 'Admin 2', email: 'admin2@exemplo.com', password: 'senha-admin-2', role: 'ADMIN' }, dona);
    await assert.rejects(() => setTenantUserCredentials(db, reg.accountId, { userId: admin2, email: 'admin2@exemplo.com', password: 'senha-admin-3' }, admin), /Só o proprietário/);
    await setTenantUserCredentials(db, reg.accountId, { userId: admin2, email: 'admin2@exemplo.com', password: 'senha-admin-3' }, dona);
    await assert.rejects(() => setTenantUserCredentials(db, reg.accountId, { userId: 'nao-existe', email: 'n@exemplo.com', password: 'senha-nnnn-1' }, dona), /não encontrado/);

    // Remover o membro encerra o acesso e libera o e-mail.
    await removeTenantUser(db, reg.accountId, 'usr-antigo', dona);
    await assert.rejects(() => loginWithPassword(db, 'antigo@exemplo.com', 'senha-nova-22'), /inválidos/);
    await createTenantUser(db, reg.accountId, { displayName: 'Novo', email: 'antigo@exemplo.com', password: 'senha-novo-12', role: 'CONSULTA' }, dona);

    // Pela API, user.assign não cria mais membro sem login.
    await assert.rejects(() => assignTenantUser(db, reg.accountId, { userId: 'fantasma', displayName: 'Fantasma', role: 'CONSULTA' }, dona, Date.now(), { mustExist: true }), /Novo membro/);
    // E o papel do OWNER não pode ser trocado por edição.
    await assert.rejects(() => assignTenantUser(db, reg.accountId, { userId: reg.userId, displayName: 'Dona', role: 'CONSULTA' }, admin), /proprietário/);
});
