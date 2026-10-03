import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { readTextLimited, readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { registerWithPlan, subscriptionDepsFromEnv } from '@/lib/subscriptions/service';
import { clientIp } from '@/lib/http/clientIp';
import { logger, pseudonym } from '@/lib/log';
import { isSameOrigin, sessionCookieHeader } from '@/app/auth';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function POST(request: Request) {
    const requestId = crypto.randomUUID();
    try {
        if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
        const body = await readJsonLimited<Record<string, unknown>>(request, 8 * 1024);
        if (!body || typeof body.accountName !== 'string' || typeof body.displayName !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') {
            return reply({ error: 'Informe nome da conta, seu nome, e-mail e senha.' }, 400);
        }
        // Cadastro com plano (escolher, pagar, usar): devolve o link do checkout do Mercado Pago.
        const { token, expiresAt, initPoint, checkoutError } = await registerWithPlan(
            database(),
            { accountName: body.accountName, displayName: body.displayName, email: body.email, password: body.password, planId: body.planId, payerEmail: body.payerEmail },
            clientIp(request.headers),
            subscriptionDepsFromEnv(),
        );
        logger.info('auth.cadastro.ok', { requestId, emailRef: pseudonym(body.email), ip: clientIp(request.headers) });
        const res = reply({ ok: true, initPoint, checkoutError }, 201);
        res.headers.append('Set-Cookie', sessionCookieHeader(token, expiresAt));
        return res;
    } catch (error) {
        if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
        if (error instanceof RuleError) {
            if (error.status === 429 || error.status === 403) logger.warn('auth.cadastro.recusado', { requestId, status: error.status, ip: clientIp(request.headers) });
            return reply({ error: error.message }, error.status);
        }
        logger.error('auth.cadastro.erro', { requestId, error });
        return reply({ error: 'Não foi possível criar a conta. Tente novamente.', requestId }, 503);
    }
}
