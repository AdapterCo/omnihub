import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { RuleError } from '../errors.ts';

// Autenticação por e-mail + senha (substitui o antigo trust de headers do proxy do
// ChatGPT Sites). Hash de senha via scrypt (nativo do Node, mesmo padrão criptográfico já
// usado em lib/fiscal/certificate.ts — sem dependência externa nova). Sessão: token opaco
// aleatório gravado em `sessions`, validado no banco a cada requisição (revogável).
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const SCRYPT_KEY_LENGTH = 64;

export function hashPassword(password: string): string {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length === 0) return false;
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
}

export function validateEmail(rawEmail: string): string {
    const email = (rawEmail || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new RuleError('E-mail inválido.', 400);
    }
    return email;
}

export function validatePasswordStrength(password: string): void {
    if (typeof password !== 'string' || password.length < 8) {
        throw new RuleError('A senha deve ter ao menos 8 caracteres.', 400);
    }
}

export type SessionUser = { userId: string; displayName: string; email: string };

export async function createSession(db: D1Database, userId: string, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = now + SESSION_TTL_MS;
    await db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(token, userId, expiresAt, now).run();
    return { token, expiresAt };
}

export async function getSessionUser(db: D1Database, token: string | undefined, now = Date.now()): Promise<SessionUser | null> {
    if (!token) return null;
    const row = await db
        .prepare(
            `SELECT s.user_id AS userId, u.display_name AS displayName, u.email AS email, s.expires_at AS expiresAt
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token = ?`,
        )
        .bind(token)
        .first<{ userId: string; displayName: string; email: string | null; expiresAt: number }>();
    if (!row) return null;
    if (Number(row.expiresAt) < now) {
        await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        return null;
    }
    return { userId: row.userId, displayName: row.displayName, email: row.email ?? '' };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

/**
 * Cria conta (tenant) + usuário dono + vínculos + sessão de forma atômica. Substitui o
 * antigo fluxo `account.create` que confiava na identidade vinda do ChatGPT.
 */
export async function registerAccount(
    db: D1Database,
    input: { accountName: string; displayName: string; email: string; password: string },
    now = Date.now(),
): Promise<{ userId: string; accountId: string; token: string; expiresAt: number }> {
    const accountName = (input.accountName || '').trim();
    const displayName = (input.displayName || '').trim();
    if (accountName.length < 2 || accountName.length > 100) throw new RuleError('Informe o nome da conta (2 a 100 caracteres).', 400);
    if (displayName.length < 2 || displayName.length > 100) throw new RuleError('Informe seu nome (2 a 100 caracteres).', 400);
    const email = validateEmail(input.email);
    validatePasswordStrength(input.password);

    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
    if (existing) throw new RuleError('Já existe uma conta com este e-mail.', 409);

    const ownerRole = await db.prepare("SELECT id FROM roles WHERE name = 'OWNER' AND tenant_id IS NULL").bind().first<{ id: string }>();
    if (!ownerRole) throw new Error('Papel OWNER não encontrado. Rode as migrações (npm run db:migrate) antes de usar o sistema.');

    const userId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    const passwordHash = hashPassword(input.password);
    const token = randomBytes(32).toString('hex');
    const expiresAt = now + SESSION_TTL_MS;

    await db.batch([
        db.prepare('INSERT INTO users (id, display_name, email, password_hash, created_at) VALUES (?,?,?,?,?)').bind(userId, displayName, email, passwordHash, now),
        db.prepare('INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES (?,?,?,0,?,?,3,?)').bind(accountId, accountName, '{}', 'trial', now + 7 * 24 * 60 * 60 * 1000, now),
        db.prepare('INSERT INTO memberships (user_id,account_id,role,store_id,display_name) VALUES (?,?,?,NULL,?)').bind(userId, accountId, 'admin', displayName),
        db.prepare('INSERT INTO user_tenant_roles (id,user_id,tenant_id,role_id) VALUES (?,?,?,?)').bind(crypto.randomUUID(), userId, accountId, ownerRole.id),
        db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,?,?,?)').bind(token, userId, expiresAt, now),
    ]);

    return { userId, accountId, token, expiresAt };
}

export async function loginWithPassword(db: D1Database, rawEmail: string, password: string, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
    const email = validateEmail(rawEmail);
    const user = await db
        .prepare('SELECT id, password_hash AS passwordHash FROM users WHERE email = ?')
        .bind(email)
        .first<{ id: string; passwordHash: string | null }>();
    // Mesma mensagem para e-mail inexistente e senha errada (não revela quais e-mails existem).
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
        throw new RuleError('E-mail ou senha inválidos.', 401);
    }
    return createSession(db, user.id, now);
}
