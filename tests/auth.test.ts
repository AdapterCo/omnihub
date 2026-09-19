import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { hashPassword, verifyPassword, registerAccount, loginWithPassword, guardedLogin, guardedRegister, isRegistrationEnabled, getSessionUser, deleteSession, MAX_PASSWORD_LENGTH } from '../lib/auth/service.ts';
import { purgeExpiredAuthData } from '../lib/auth/rateLimit.ts';
import { clientIp } from '../lib/http/clientIp.ts';

const input = { accountName: 'Grupo Teste', displayName: 'Maria Souza', email: 'Maria@Empresa.com', password: 'senha-forte-123' };

test('hashPassword/verifyPassword: aceita a senha certa e rejeita a errada; hash nunca contém a senha', async () => {
 const hash = await hashPassword('abc12345');
 assert.ok(!hash.includes('abc12345'));
 assert.equal(await verifyPassword('abc12345', hash), true);
 assert.equal(await verifyPassword('outra-senha', hash), false);
 assert.equal(await verifyPassword('abc12345', 'lixo'), false);
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

test('senha acima do limite é recusada no cadastro e no login (sem gastar hash)', async () => {
 const db = createFakeD1();
 const longPassword = 'a'.repeat(MAX_PASSWORD_LENGTH + 1);
 await assert.rejects(() => registerAccount(db, { ...input, password: longPassword }), /no máximo/);
 await registerAccount(db, input);
 await assert.rejects(() => loginWithPassword(db, 'maria@empresa.com', longPassword), /E-mail ou senha inválidos/);
});

test('guardedLogin: 5 senhas erradas trancam o e-mail; senha certa também é barrada durante o bloqueio e volta depois', async () => {
 const db = createFakeD1();
 const t0 = 1_000_000;
 await registerAccount(db, input, t0);
 for (let i = 0; i < 5; i++) await assert.rejects(() => guardedLogin(db, 'maria@empresa.com', 'errada-errada', '203.0.113.9', t0 + i), /E-mail ou senha inválidos/);
 await assert.rejects(() => guardedLogin(db, 'maria@empresa.com', input.password, '203.0.113.9', t0 + 10), /Muitas tentativas/);
 await assert.rejects(() => guardedLogin(db, 'maria@empresa.com', input.password, '198.51.100.1', t0 + 10), /Muitas tentativas/);
 const later = t0 + 16 * 60 * 1000;
 const ok = await guardedLogin(db, 'maria@empresa.com', input.password, '203.0.113.9', later);
 assert.ok(await getSessionUser(db, ok.token, later));
});

test('guardedLogin: login correto zera o contador de erros do e-mail', async () => {
 const db = createFakeD1();
 await registerAccount(db, input, 1000);
 for (let i = 0; i < 4; i++) await assert.rejects(() => guardedLogin(db, 'maria@empresa.com', 'errada-errada', '203.0.113.9', 2000 + i));
 await guardedLogin(db, 'maria@empresa.com', input.password, '203.0.113.9', 3000);
 for (let i = 0; i < 4; i++) await assert.rejects(() => guardedLogin(db, 'maria@empresa.com', 'errada-errada', '203.0.113.9', 4000 + i), /E-mail ou senha inválidos/);
});

test('guardedLogin: 20 erros do mesmo IP trancam o IP mesmo com e-mails diferentes', async () => {
 const db = createFakeD1();
 for (let i = 0; i < 20; i++) await assert.rejects(() => guardedLogin(db, `u${i}@empresa.com`, 'errada-errada', '203.0.113.50', 1000 + i), /E-mail ou senha inválidos/);
 await assert.rejects(() => guardedLogin(db, 'novo@empresa.com', 'errada-errada', '203.0.113.50', 2000), /Muitas tentativas/);
 await assert.rejects(() => guardedLogin(db, 'novo@empresa.com', 'errada-errada', '203.0.113.51', 2000), /E-mail ou senha inválidos/);
});

test('guardedRegister: 5 contas por IP na hora; erros de formulário não contam; cadastro pode ser desativado', async () => {
 const db = createFakeD1();
 const ip = '203.0.113.7';
 for (let i = 0; i < 3; i++) await assert.rejects(() => guardedRegister(db, { ...input, email: 'invalido' }, ip, 1000));
 for (let i = 0; i < 5; i++) await guardedRegister(db, { ...input, email: `p${i}@empresa.com` }, ip, 1000 + i);
 await assert.rejects(() => guardedRegister(db, { ...input, email: 'p9@empresa.com' }, ip, 2000), /Muitas tentativas/);
 await guardedRegister(db, { ...input, email: 'p9@empresa.com' }, '203.0.113.8', 2000);
 assert.equal(isRegistrationEnabled({}), true);
 assert.equal(isRegistrationEnabled({ REGISTRATION_ENABLED: 'false' }), false);
 await assert.rejects(() => guardedRegister(createFakeD1(), input, ip, 1000, { REGISTRATION_ENABLED: 'false' }), /desativado/);
});

test('purgeExpiredAuthData remove sessões vencidas e contadores antigos, preservando os vigentes', async () => {
 const db = createFakeD1();
 const old = await registerAccount(db, input, 1000);
 const fresh = await loginWithPassword(db, 'maria@empresa.com', input.password, old.expiresAt + 5000);
 await purgeExpiredAuthData(db, old.expiresAt + 6000);
 const rows = await db.prepare('SELECT token FROM sessions').bind().all<{ token: string }>();
 assert.deepEqual(rows.results.map((r) => r.token), [fresh.token]);
});

test('clientIp: usa o item do fim de x-forwarded-for (proxy confiável), nunca o primeiro forjável', () => {
 const h = (v: Record<string, string>) => new Headers(v);
 assert.equal(clientIp(h({ 'x-forwarded-for': '198.51.100.1' }), {}), '198.51.100.1');
 assert.equal(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 198.51.100.1' }), {}), '198.51.100.1');
 assert.equal(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 198.51.100.1, 10.0.0.2' }), { TRUSTED_PROXY_HOPS: '2' }), '198.51.100.1');
 assert.equal(clientIp(h({ 'cf-connecting-ip': '6.6.6.6' }), {}), null);
 assert.equal(clientIp(h({ 'x-forwarded-for': 'lixo' }), {}), null);
 assert.equal(clientIp(h({ 'x-real-ip': '2001:db8::1' }), {}), '2001:db8::1');
 assert.equal(clientIp(h({}), {}), null);
});
