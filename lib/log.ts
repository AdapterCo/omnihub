import { createHash } from 'node:crypto';

// Log estruturado (§56): uma linha JSON por evento em stdout/stderr, pronta para
// `docker compose logs` e para qualquer coletor. Nunca grava segredos: chaves sensíveis são
// mascaradas e erros são reduzidos a nome/mensagem/código (o `detail` do PostgreSQL pode
// conter valores de linhas, como e-mails, por isso não é registrado).
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_KEY = /pass(word|phrase)?|senha|secret|token|cookie|authorization|csc|pfx|privatekey|certbase64|cert(ificate)?pem/i;
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function redact(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return value;
    if (depth > 6) return '[profundidade máxima]';
    if (value instanceof Error) return serializeError(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(val, depth + 1);
        }
        return out;
    }
    if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
    return value;
}

export function serializeError(error: unknown): Record<string, unknown> {
    if (!(error instanceof Error)) return { message: String(error).slice(0, 500) };
    const code = (error as { code?: unknown }).code;
    return {
        name: error.name,
        message: error.message.slice(0, 500),
        ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
        ...(process.env.NODE_ENV === 'production' ? {} : { stack: error.stack?.split('\n').slice(0, 6).join('\n') }),
    };
}

/** Identificador estável e não reversível de um dado pessoal (ex.: e-mail) para correlacionar eventos sem gravar o dado (LGPD). */
export function pseudonym(value: string): string {
    return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 12);
}

function minLevel(env: Record<string, string | undefined>): number {
    const configured = (env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
    return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}, env: Record<string, string | undefined> = process.env): void {
    if (LEVEL_ORDER[level] < minLevel(env)) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as Record<string, unknown>) });
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
}

export const logger = {
    debug: (event: string, fields?: Record<string, unknown>) => log('debug', event, fields),
    info: (event: string, fields?: Record<string, unknown>) => log('info', event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => log('warn', event, fields),
    error: (event: string, fields?: Record<string, unknown>) => log('error', event, fields),
};
