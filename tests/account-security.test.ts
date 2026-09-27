import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeD1 } from './helpers/fakeD1.ts';
import { registerAccount, guardedLogin, getSessionUser, createSession, loginWithPassword } from '../lib/auth/service.ts';
import { base32Decode, hotp, totpStep, verifyTotp, base32Encode } from '../lib/auth/totp.ts';
import { changeOwnPassword, requestPasswordReset, resetPasswordWithToken, beginTwoFactorSetup, enableTwoFactor, disableTwoFactor, completeLoginChallenge, twoFactorStatus } from '../lib/auth/security.ts';
import { mailConfigProblems, type Mailer, type MailMessage } from '../lib/mail.ts';

process.env.FISCAL_SECRET_KEY ??= 'MOCK-TEST-ONLY-account-security-key-32ch';
const input = { accountName: 'Loja', displayName: 'Maria', email: 'maria@empresa.com', password: 'senha-forte-123' };
const T0 = Date.UTC(2026, 8, 27, 12);

// MOCK EXPLÍCITO de envio de e-mail: só testes; produção usa SMTP (lib/mail.ts).
function mockMailer(): Mailer & { sent: MailMessage[] } {
 const sent: MailMessage[] = [];
 return { appUrl: 'https://omnihub.exemplo.test', sent, async send(m) { sent.push(m); } };
}
const tokenFrom = (m: MailMessage) => /reset=([a-f0-9]{64})/.exec(m.text)![1];
const codeAt = (secret: string, now: number) => hotp(base32Decode(secret), totpStep(now));

test('TOTP: vetores oficiais (RFC 4226/6238) e tolerância de ±30 s sem reaproveitar código', () => {
 const rfcSecret = Buffer.from('12345678901234567890');
 assert.equal(hotp(rfcSecret, 0), '755224');
 assert.equal(hotp(rfcSecret, 1), '287082'); // RFC 6238, T=59 s (6 últimos dígitos de 94287082)
 const b32 = base32Encode(rfcSecret);
 assert.equal(b32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
 const step = totpStep(59_000);
 assert.equal(verifyTotp(b32, '287082', 59_000), step);
 assert.equal(verifyTotp(b32, '287082', 59_000 + 30_000), step, 'aceita o passo anterior');
 assert.equal(verifyTotp(b32, '287082', 59_000 + 90_000), null, 'fora da tolerância');
 assert.equal(verifyTotp(b32, '287082', 59_000, step), null, 'o mesmo passo não vale duas vezes');
 assert.equal(verifyTotp(b32, 'abc', 59_000), null);
});

test('troca da própria senha: exige a atual, mantém a sessão em uso e encerra as outras', async () => {
 const db = createFakeD1();
 const reg = await registerAccount(db, input, T0);
 const other = await createSession(db, reg.userId, T0);
 await assert.rejects(() => changeOwnPassword(db, reg.userId, reg.token, { currentPassword: 'errada-123', newPassword: 'nova-senha-456' }, T0), /Senha atual incorreta/);
 await assert.rejects(() => changeOwnPassword(db, reg.userId, reg.token, { currentPassword: input.password, newPassword: 'curta' }, T0), /8 caracteres/);
 await changeOwnPassword(db, reg.userId, reg.token, { currentPassword: input.password, newPassword: 'nova-senha-456' }, T0);
 assert.ok(await getSessionUser(db, reg.token, T0 + 1), 'sessão atual continua');
 assert.equal(await getSessionUser(db, other.token, T0 + 1), null, 'outras sessões encerradas');
 await assert.rejects(() => loginWithPassword(db, input.email, input.password, T0 + 2), /inválidos/);
 assert.ok(await loginWithPassword(db, input.email, 'nova-senha-456', T0 + 2));
});

test('recuperação por e-mail: resposta igual para e-mail inexistente, link de uso único e com prazo', async () => {
 const db = createFakeD1();
 const reg = await registerAccount(db, input, T0);
 const mailer = mockMailer();
 await requestPasswordReset(db, mailer, 'ninguem@empresa.com', '198.51.100.1', T0);
 assert.equal(mailer.sent.length, 0, 'e-mail sem conta não recebe nada (e a rota responde igual)');
 await requestPasswordReset(db, mailer, input.email, '198.51.100.1', T0);
 assert.equal(mailer.sent.length, 1);
 assert.equal(mailer.sent[0].to, input.email);
 assert.match(mailer.sent[0].text, /https:\/\/omnihub\.exemplo\.test\/\?reset=/);
 const token = tokenFrom(mailer.sent[0]);
 const row = await db.prepare('SELECT token_hash AS h FROM password_resets').bind().first<{ h: string }>();
 assert.notEqual(row!.h, token, 'banco guarda só o hash');
 await assert.rejects(() => resetPasswordWithToken(db, token, 'nova-senha-789', '198.51.100.1', T0 + 31 * 60_000), /vencido/);
 await resetPasswordWithToken(db, token, 'nova-senha-789', '198.51.100.1', T0 + 60_000);
 assert.equal(await getSessionUser(db, reg.token, T0 + 61_000), null, 'todas as sessões encerradas');
 await assert.rejects(() => resetPasswordWithToken(db, token, 'outra-senha-000', '198.51.100.1', T0 + 62_000), /inválido|usado/);
 assert.ok(await loginWithPassword(db, input.email, 'nova-senha-789', T0 + 63_000));
 // Excesso de pedidos por e-mail: silencioso (não envia mais, mesma resposta).
 for (let i = 0; i < 4; i++) await requestPasswordReset(db, mailer, input.email, `203.0.113.${i}`, T0 + 70_000 + i);
 assert.ok(mailer.sent.length <= 4, 'no máximo 3 envios por hora para o mesmo e-mail');
});

test('SMTP: sem configuração completa a recuperação fica desligada (nada presumido)', () => {
 assert.ok(mailConfigProblems({}).includes('SMTP_HOST não definida'));
 const full = { SMTP_HOST: 'smtp.exemplo.test', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'OmniHub <no-reply@exemplo.test>', APP_URL: 'https://omnihub.exemplo.test' };
 assert.deepEqual(mailConfigProblems(full), []);
 assert.ok(mailConfigProblems({ ...full, APP_URL: 'http://omnihub.exemplo.test' }).includes('APP_URL deve usar https'));
 assert.ok(mailConfigProblems({ ...full, SMTP_SECURE: 'talvez' }).length === 1);
});

test('2FA: ativação com código, login em duas etapas, código não reaproveitável, recuperação de uso único', async () => {
 const db = createFakeD1();
 const reg = await registerAccount(db, input, T0);
 await assert.rejects(() => beginTwoFactorSetup(db, reg.userId, 'errada-123', T0), /Senha atual incorreta/);
 const { secret, uri } = await beginTwoFactorSetup(db, reg.userId, input.password, T0);
 assert.match(uri, /^otpauth:\/\/totp\/OmniHub%3Amaria%40empresa\.com\?secret=/);
 const pending = await db.prepare('SELECT totp_pending_enc AS p FROM users WHERE id = ?').bind(reg.userId).first<{ p: string }>();
 assert.ok(!pending!.p.includes(secret), 'segredo cifrado no banco');
 // Antes de confirmar, o login continua só com senha.
 assert.ok('token' in (await guardedLogin(db, input.email, input.password, '198.51.100.1', T0)));
 await assert.rejects(() => enableTwoFactor(db, reg.userId, '000000', T0), /Código incorreto/);
 const { recoveryCodes } = await enableTwoFactor(db, reg.userId, codeAt(secret, T0), T0);
 assert.equal(recoveryCodes.length, 8);
 assert.deepEqual(await twoFactorStatus(db, reg.userId), { enabled: true, recoveryCodesLeft: 8 });

 // Login agora exige o código; senha certa gera só o desafio.
 const t1 = T0 + 60_000;
 const first = await guardedLogin(db, input.email, input.password, '198.51.100.1', t1);
 assert.ok('challenge' in first);
 await assert.rejects(() => loginWithPassword(db, input.email, input.password, t1), /duas etapas/);
 await assert.rejects(() => completeLoginChallenge(db, first.challenge, '000000', t1), /Código incorreto/);
 const session = await completeLoginChallenge(db, first.challenge, codeAt(secret, t1), t1);
 assert.ok(await getSessionUser(db, session.token, t1));
 await assert.rejects(() => completeLoginChallenge(db, first.challenge, codeAt(secret, t1), t1), /expirou/, 'desafio de uso único');
 const again = await guardedLogin(db, input.email, input.password, '198.51.100.1', t1);
 assert.ok('challenge' in again);
 await assert.rejects(() => completeLoginChallenge(db, again.challenge, codeAt(secret, t1), t1), /Código incorreto/, 'mesmo código não vale duas vezes');
 const viaRecovery = await completeLoginChallenge(db, again.challenge, recoveryCodes[0].toLowerCase(), t1);
 assert.ok(viaRecovery.token);
 const third = await guardedLogin(db, input.email, input.password, '198.51.100.1', t1);
 assert.ok('challenge' in third);
 await assert.rejects(() => completeLoginChallenge(db, third.challenge, recoveryCodes[0], t1), /Código incorreto/, 'código de recuperação é de uso único');
 for (let i = 0; i < 4; i++) await assert.rejects(() => completeLoginChallenge(db, third.challenge, '111111', t1));
 await assert.rejects(() => completeLoginChallenge(db, third.challenge, codeAt(secret, t1 + 30_000), t1 + 30_000), /expirou/, 'após 5 erros o desafio morre');
 const expiring = await guardedLogin(db, input.email, input.password, '198.51.100.1', t1);
 assert.ok('challenge' in expiring);
 await assert.rejects(() => completeLoginChallenge(db, expiring.challenge, codeAt(secret, t1 + 6 * 60_000), t1 + 6 * 60_000), /expirou/, 'desafio vale 5 minutos');

 // Desativar exige senha e código.
 const t2 = t1 + 120_000;
 await assert.rejects(() => disableTwoFactor(db, reg.userId, { password: input.password, code: '000000' }, t2), /Código incorreto/);
 await disableTwoFactor(db, reg.userId, { password: input.password, code: recoveryCodes[1] }, t2);
 assert.deepEqual(await twoFactorStatus(db, reg.userId), { enabled: false, recoveryCodesLeft: 0 });
 assert.ok('token' in (await guardedLogin(db, input.email, input.password, '198.51.100.1', t2)));
});

test('administrador redefinindo o acesso de um membro desliga o 2FA dele (celular perdido)', async () => {
 const { createTenantUser, setTenantUserCredentials } = await import('../lib/users/service.ts');
 const { permissionsForRole } = await import('../lib/authz/roles.ts');
 const db = createFakeD1();
 const reg = await registerAccount(db, input, T0);
 const owner = { userId: reg.userId, displayName: 'Maria', role: 'admin', storeId: null, permissions: permissionsForRole('OWNER') };
 const memberId = await createTenantUser(db, reg.accountId, { displayName: 'Joana', email: 'joana@empresa.com', password: 'senha-joana-1', role: 'OPERADOR_CAIXA', storeId: null }, owner as never);
 const { secret } = await beginTwoFactorSetup(db, memberId, 'senha-joana-1', T0);
 await enableTwoFactor(db, memberId, codeAt(secret, T0), T0);
 await setTenantUserCredentials(db, reg.accountId, { userId: memberId, email: 'joana@empresa.com', password: 'senha-nova-22' }, owner as never);
 assert.deepEqual(await twoFactorStatus(db, memberId), { enabled: false, recoveryCodesLeft: 0 });
 assert.ok('token' in (await guardedLogin(db, 'joana@empresa.com', 'senha-nova-22', '198.51.100.1', T0 + 1000)));
});
