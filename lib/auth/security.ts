import { createHash, randomBytes } from 'node:crypto';
import { RuleError } from '../errors.ts';
import { encryptPayload, decryptPayload, type EncryptedPayload } from '../fiscal/certificate.ts';
import { escapeHtml, type Mailer } from '../mail.ts';
import { assertNotLocked, recordHit, resetBucket, LOGIN_EMAIL_RULE, type RateRule } from './rateLimit.ts';
import { createSession, hashPassword, sessionTokenHash, validateEmail, validatePasswordStrength, verifyPassword, LOGIN_CHALLENGE_MAX_ATTEMPTS } from './service.ts';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.ts';

// Segurança da própria conta: troca de senha, recuperação por e-mail e verificação em duas etapas
// (TOTP). Tokens de recuperação, desafios de login e códigos de recuperação são guardados só como
// SHA-256; o segredo TOTP é cifrado (AES-256-GCM com FISCAL_SECRET_KEY).
const MINUTE = 60 * 1000;
export const RESET_TTL_MS = 30 * MINUTE;
const FORGOT_IP_RULE: RateRule = { max: 5, windowMs: 60 * MINUTE, lockMs: 60 * MINUTE };
const FORGOT_EMAIL_RULE: RateRule = { max: 3, windowMs: 60 * MINUTE, lockMs: 60 * MINUTE };
const RESET_IP_RULE: RateRule = { max: 10, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE };
const RECOVERY_CODE_COUNT = 8;
const ISSUER = 'OmniHub';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const encrypt = (text: string) => JSON.stringify(encryptPayload(text));
function decrypt(stored: string): string {
 try {
  return decryptPayload(JSON.parse(stored) as EncryptedPayload).toString('utf8');
 } catch {
  throw new RuleError('Não foi possível ler o segredo da verificação em duas etapas. Confira a chave de criptografia do servidor.', 409);
 }
}

type UserRow = { id: string; email: string | null; passwordHash: string | null; totpSecretEnc: string | null; totpPendingEnc: string | null; totpEnabledAt: number | null; totpLastStep: number | null };
async function loadUser(db: D1Database, userId: string): Promise<UserRow> {
 const row = await db
  .prepare('SELECT id, email, password_hash AS passwordHash, totp_secret_enc AS totpSecretEnc, totp_pending_enc AS totpPendingEnc, totp_enabled_at AS totpEnabledAt, totp_last_step AS totpLastStep FROM users WHERE id = ?')
  .bind(userId)
  .first<UserRow>();
 if (!row) throw new RuleError('Usuário não encontrado.', 404);
 return row;
}

async function assertCurrentPassword(db: D1Database, user: UserRow, password: string, now: number): Promise<void> {
 const bucket = `password:user:${user.id}`;
 await assertNotLocked(db, bucket, now);
 const ok = typeof password === 'string' && password.length <= 128 && !!user.passwordHash && (await verifyPassword(password, user.passwordHash));
 if (!ok) {
  await recordHit(db, bucket, LOGIN_EMAIL_RULE, now);
  throw new RuleError('Senha atual incorreta.', 401);
 }
 await resetBucket(db, bucket);
}

/** Troca a própria senha (exige a atual) e encerra as outras sessões do usuário. */
export async function changeOwnPassword(db: D1Database, userId: string, currentToken: string, input: { currentPassword: string; newPassword: string }, now = Date.now()): Promise<void> {
 const user = await loadUser(db, userId);
 await assertCurrentPassword(db, user, input.currentPassword, now);
 validatePasswordStrength(input.newPassword);
 if (input.newPassword === input.currentPassword) throw new RuleError('A nova senha deve ser diferente da atual.', 400);
 await db.batch([
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(input.newPassword), userId),
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').bind(userId, sessionTokenHash(currentToken)),
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(userId),
 ]);
}

/**
 * "Esqueci minha senha". A resposta é sempre a mesma (não revela se o e-mail existe). Sem SMTP
 * configurado, a rota nem chama esta função (a tela orienta a pedir ao administrador).
 */
export async function requestPasswordReset(db: D1Database, mailer: Mailer, rawEmail: string, ip: string | null, now = Date.now()): Promise<void> {
 const email = validateEmail(rawEmail);
 const ipBucket = `forgot:ip:${ip ?? 'desconhecido'}`;
 const emailBucket = `forgot:email:${email}`;
 await assertNotLocked(db, ipBucket, now);
 await recordHit(db, ipBucket, FORGOT_IP_RULE, now);
 // Limite por e-mail: silencioso (mesma resposta), para não virar forma de descobrir contas.
 const locked = await db.prepare('SELECT locked_until AS lockedUntil FROM auth_rate_limits WHERE bucket = ?').bind(emailBucket).first<{ lockedUntil: number }>();
 if (locked && Number(locked.lockedUntil) > now) return;
 await recordHit(db, emailBucket, FORGOT_EMAIL_RULE, now);
 const user = await db.prepare('SELECT id, display_name AS displayName FROM users WHERE email = ? AND password_hash IS NOT NULL').bind(email).first<{ id: string; displayName: string }>();
 if (!user) return;
 const token = randomBytes(32).toString('hex');
 await db.batch([
  db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').bind(user.id, now),
  db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at, used_at, created_at) VALUES (?,?,?,NULL,?)').bind(sessionTokenHash(token), user.id, now + RESET_TTL_MS, now),
 ]);
 const link = `${mailer.appUrl}/?reset=${token}`;
 const name = user.displayName || email;
 await mailer.send({
  to: email,
  subject: 'OmniHub — redefinição de senha',
  text: `Olá, ${name}.\n\nRecebemos um pedido para redefinir a senha da sua conta no OmniHub. Para criar uma nova senha, acesse o link abaixo (válido por 30 minutos, uso único):\n\n${link}\n\nSe você não pediu, ignore este e-mail: sua senha continua a mesma.`,
  html: `<p>Olá, ${escapeHtml(name)}.</p><p>Recebemos um pedido para redefinir a senha da sua conta no OmniHub.</p><p><a href="${escapeHtml(link)}">Criar uma nova senha</a> (válido por 30 minutos, uso único).</p><p>Se você não pediu, ignore este e-mail: sua senha continua a mesma.</p>`,
 });
}

/** Conclui a recuperação: token válido, não usado e no prazo; encerra todas as sessões. */
export async function resetPasswordWithToken(db: D1Database, token: string, newPassword: string, ip: string | null, now = Date.now()): Promise<void> {
 const ipBucket = `reset:ip:${ip ?? 'desconhecido'}`;
 await assertNotLocked(db, ipBucket, now);
 const hash = /^[a-f0-9]{64}$/.test(String(token ?? '')) ? sessionTokenHash(token) : '';
 const row = hash ? await db.prepare('SELECT user_id AS userId, expires_at AS expiresAt, used_at AS usedAt FROM password_resets WHERE token_hash = ?').bind(hash).first<{ userId: string; expiresAt: number; usedAt: number | null }>() : null;
 if (!row || row.usedAt != null || Number(row.expiresAt) < now) {
  await recordHit(db, ipBucket, RESET_IP_RULE, now);
  throw new RuleError('Link de redefinição inválido ou vencido. Peça um novo em "Esqueci minha senha".', 400);
 }
 validatePasswordStrength(newPassword);
 const claim = await db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(now, hash).run();
 if (claim.meta.changes !== 1) throw new RuleError('Este link já foi usado.', 409);
 await db.batch([
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(newPassword), row.userId),
  db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.userId),
  db.prepare('DELETE FROM login_challenges WHERE user_id = ?').bind(row.userId),
  db.prepare('DELETE FROM auth_rate_limits WHERE bucket = ?').bind(`password:user:${row.userId}`),
 ]);
}

// ---------------------------------------------------------------- verificação em duas etapas

export async function twoFactorStatus(db: D1Database, userId: string): Promise<{ enabled: boolean; recoveryCodesLeft: number }> {
 const user = await loadUser(db, userId);
 const left = await db.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL').bind(userId).first<{ n: number }>();
 return { enabled: user.totpEnabledAt != null, recoveryCodesLeft: Number(left?.n ?? 0) };
}

/** Passo 1: gera um segredo pendente (ainda não vale no login) e a URI para o QR Code. */
export async function beginTwoFactorSetup(db: D1Database, userId: string, password: string, now = Date.now()): Promise<{ secret: string; uri: string }> {
 const user = await loadUser(db, userId);
 if (user.totpEnabledAt != null) throw new RuleError('A verificação em duas etapas já está ativa.', 409);
 await assertCurrentPassword(db, user, password, now);
 const secret = newTotpSecret();
 await db.prepare('UPDATE users SET totp_pending_enc = ? WHERE id = ?').bind(encrypt(secret), userId).run();
 return { secret, uri: otpauthUri(secret, user.email ?? userId, ISSUER) };
}

function newRecoveryCode(): string {
 const raw = randomBytes(8).toString('hex').toUpperCase().slice(0, 10);
 return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}
const normalizeRecovery = (code: string) => String(code ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');

/** Passo 2: confirma com um código do app; ativa e devolve os códigos de recuperação (uma única vez). */
export async function enableTwoFactor(db: D1Database, userId: string, code: string, now = Date.now()): Promise<{ recoveryCodes: string[] }> {
 const user = await loadUser(db, userId);
 if (user.totpEnabledAt != null) throw new RuleError('A verificação em duas etapas já está ativa.', 409);
 if (!user.totpPendingEnc) throw new RuleError('Comece a configuração novamente.', 409);
 const secret = decrypt(user.totpPendingEnc);
 const step = verifyTotp(secret, code, now);
 if (step === null) throw new RuleError('Código incorreto. Confira o horário do celular e tente o código atual do aplicativo.', 400);
 const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
 await db.batch([
  db.prepare('UPDATE users SET totp_secret_enc = ?, totp_pending_enc = NULL, totp_enabled_at = ?, totp_last_step = ? WHERE id = ?').bind(user.totpPendingEnc, now, step, userId),
  db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').bind(userId),
  ...codes.map((c) => db.prepare('INSERT INTO user_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?,?,?,NULL,?)').bind(crypto.randomUUID(), userId, sha256(normalizeRecovery(c)), now)),
 ]);
 return { recoveryCodes: codes };
}

/** Confere código do app (sem reaproveitar o mesmo) ou um código de recuperação (uso único). */
async function consumeSecondFactor(db: D1Database, user: UserRow, code: string, now: number): Promise<boolean> {
 if (!user.totpSecretEnc) return false;
 const digits = String(code ?? '').replace(/\s/g, '');
 if (/^\d{6}$/.test(digits)) {
  const step = verifyTotp(decrypt(user.totpSecretEnc), digits, now, user.totpLastStep == null ? null : Number(user.totpLastStep));
  if (step === null) return false;
  const claim = await db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)').bind(step, user.id, step).run();
  return claim.meta.changes === 1;
 }
 const normalized = normalizeRecovery(code);
 if (normalized.length !== 10) return false;
 const used = await db.prepare('UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').bind(now, user.id, sha256(normalized)).run();
 return used.meta.changes === 1;
}

/** Desativa (exige senha + código do app ou de recuperação). */
export async function disableTwoFactor(db: D1Database, userId: string, input: { password: string; code: string }, now = Date.now()): Promise<void> {
 const user = await loadUser(db, userId);
 if (user.totpEnabledAt == null) throw new RuleError('A verificação em duas etapas não está ativa.', 409);
 await assertCurrentPassword(db, user, input.password, now);
 if (!(await consumeSecondFactor(db, user, input.code, now))) throw new RuleError('Código incorreto.', 400);
 await db.batch([
  db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?').bind(userId),
  db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').bind(userId),
 ]);
}

/** Segunda etapa do login: desafio válido + código → sessão. */
export async function completeLoginChallenge(db: D1Database, challenge: string, code: string, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
 const hash = /^[a-f0-9]{64}$/.test(String(challenge ?? '')) ? sessionTokenHash(challenge) : '';
 const row = hash ? await db.prepare('SELECT user_id AS userId, expires_at AS expiresAt, attempts FROM login_challenges WHERE token_hash = ?').bind(hash).first<{ userId: string; expiresAt: number; attempts: number }>() : null;
 if (!row || Number(row.expiresAt) < now || Number(row.attempts) >= LOGIN_CHALLENGE_MAX_ATTEMPTS) {
  if (row) await db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').bind(hash).run();
  throw new RuleError('A verificação expirou. Entre novamente com e-mail e senha.', 401);
 }
 const user = await loadUser(db, row.userId);
 if (!(await consumeSecondFactor(db, user, code, now))) {
  await db.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = ?').bind(hash).run();
  throw new RuleError('Código incorreto.', 400);
 }
 await db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').bind(hash).run();
 return createSession(db, row.userId, now);
}

/** Administrador redefinindo o acesso de um membro (celular perdido): desliga o 2FA dele. */
export function resetTwoFactorStatements(db: D1Database, userId: string): D1PreparedStatement[] {
 return [
  db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?').bind(userId),
  db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').bind(userId),
  db.prepare('DELETE FROM login_challenges WHERE user_id = ?').bind(userId),
 ];
}
