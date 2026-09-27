import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { isSameOrigin, sessionCookieHeader } from '@/app/auth';
import { completeLoginChallenge } from '@/lib/auth/security';
import { clientIp } from '@/lib/http/clientIp';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** Segunda etapa do login: código do app autenticador (ou de recuperação) para o desafio. */
export async function POST(request: Request) {
    const requestId = crypto.randomUUID();
    try {
        if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
        const body = await readJsonLimited<{ challenge?: unknown; code?: unknown }>(request, 4 * 1024);
        if (!body || typeof body.challenge !== 'string' || typeof body.code !== 'string') return reply({ error: 'Informe o código.' }, 400);
        const { token, expiresAt } = await completeLoginChallenge(database(), body.challenge, body.code);
        logger.info('auth.login.ok', { requestId, twoFactor: true, ip: clientIp(request.headers) });
        const res = reply({ ok: true });
        res.headers.append('Set-Cookie', sessionCookieHeader(token, expiresAt));
        return res;
    } catch (error) {
        if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
        if (error instanceof RuleError) {
            logger.warn('auth.login.2fa_falhou', { requestId, status: error.status, ip: clientIp(request.headers) });
            return reply({ error: error.message }, error.status);
        }
        logger.error('auth.login.erro', { requestId, error });
        return reply({ error: 'Não foi possível entrar. Tente novamente.', requestId }, 503);
    }
}
