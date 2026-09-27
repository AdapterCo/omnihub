import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { guardedLogin } from '@/lib/auth/service';
import { clientIp } from '@/lib/http/clientIp';
import { logger, pseudonym } from '@/lib/log';
import { isSameOrigin, sessionCookieHeader } from '@/app/auth';
import { readTextLimited, readJsonLimited, BodyTooLargeError } from '@/lib/http/body';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function POST(request: Request) {
    const requestId = crypto.randomUUID();
    let emailRef: string | undefined;
    try {
        if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
        const body = await readJsonLimited<{ email?: unknown; password?: unknown }>(request, 8 * 1024);
        if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') return reply({ error: 'Informe e-mail e senha.' }, 400);
        emailRef = pseudonym(body.email);
        const result = await guardedLogin(database(), body.email, body.password, clientIp(request.headers));
        if ('challenge' in result) {
            // Senha certa, conta com verificação em duas etapas: a sessão só sai com o código.
            logger.info('auth.login.2fa_pedido', { requestId, emailRef, ip: clientIp(request.headers) });
            return reply({ twoFactorRequired: true, challenge: result.challenge });
        }
        logger.info('auth.login.ok', { requestId, emailRef, ip: clientIp(request.headers) });
        const res = reply({ ok: true });
        res.headers.append('Set-Cookie', sessionCookieHeader(result.token, result.expiresAt));
        return res;
    } catch (error) {
        if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
        if (error instanceof RuleError) {
            // 401 = credencial errada, 429 = bloqueio por excesso de tentativas: sinais de ataque/erro de uso.
            if (error.status === 401 || error.status === 429) logger.warn(error.status === 429 ? 'auth.login.bloqueado' : 'auth.login.falhou', { requestId, emailRef, ip: clientIp(request.headers) });
            return reply({ error: error.message }, error.status);
        }
        logger.error('auth.login.erro', { requestId, error });
        return reply({ error: 'Não foi possível entrar. Tente novamente.', requestId }, 503);
    }
}
