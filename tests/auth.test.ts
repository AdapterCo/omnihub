import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { hashPassword, verifyPassword, registerAccount, loginWithPassword, getSessionUser, deleteSession } from '../lib/auth/service.ts';

const input = { accountName: 'Grupo Teste', displayName: 'Maria Souza', email: 'Maria@Empresa.com', password: 'senha-forte-123' };

test('hashPassword/verifyPassword: aceita a senha certa e rejeita a errada; hash nunca contém a senha', () => {
 const hash = hashPassword('abc12345');
 assert.ok(!hash.includes('abc12345'));
 assert.equal(verifyPassword('abc12345', hash), true);
 assert.equal(verifyPassword('outra-senha', hash), false);
 assert.equal(verifyPassword('abc12345', 'lixo'), false);
});

test('registerAccount cria conta, usuário dono, vínculos e sessão válida', async () => {
 const db = createFakeD1();
 const r = await registerAccount(db, input);
 const user = await getSessionUser(db, r.token);
 assert.equal(user?.email, 'maria@empresa.com');
 const m = await db.prepare('SELECT role, account_id AS accountId FROM memberships WHERE user_id = ?').bind(r.userId).first<{ role: string; accountId: string }>();
 assert.equal(m?.role, 'admin');
 assert.equal(m?.accountId, r.accountId);
 const stored = await db.prepare('SELECT password_hash AS h FROM users WHERE id = ?').bind(r.userId).first<{ h: string }>();
 assert.ok(!stored!.h.includes(input.password));
});

test('registerAccount bloqueia e-mail duplicado, e-mail inválido e senha curta', async () => {
 const db = createFakeD1();
 await registerAccount(db, input);
 await assert.rejects(() => registerAccount(db, { ...input, email: 'maria@empresa.com' }), /Já existe uma conta/);
 await assert.rejects(() => registerAccount(createFakeD1(), { ...input, email: 'invalido' }), /E-mail inválido/);
 await assert.rejects(() => registerAccount(createFakeD1(), { ...input, password: '123' }), /ao menos 8/);
});

test('loginWithPassword: senha certa cria sessão; errada/e-mail inexistente dão a mesma mensagem', async () => {
 const db = createFakeD1();
 await registerAccount(db, input);
 const ok = await loginWithPassword(db, 'maria@empresa.com', input.password);
 assert.ok(await getSessionUser(db, ok.token));
 await assert.rejects(() => loginWithPassword(db, 'maria@empresa.com', 'errada-errada'), /E-mail ou senha inválidos/);
 await assert.rejects(() => loginWithPassword(db, 'ninguem@empresa.com', input.password), /E-mail ou senha inválidos/);
});

test('sessão expira e logout a revoga', async () => {
 const db = createFakeD1();
 const r = await registerAccount(db, input, 1000);
 assert.equal(await getSessionUser(db, r.token, r.expiresAt + 1), null);
 const r2 = await loginWithPassword(db, 'maria@empresa.com', input.password);
 await deleteSession(db, r2.token);
 assert.equal(await getSessionUser(db, r2.token), null);
 assert.equal(await getSessionUser(db, undefined), null);
});
