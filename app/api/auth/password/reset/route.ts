import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { isSameOrigin } from '@/app/auth';
import { resetPasswordWithToken } from '@/lib/auth/security';
import { clientIp } from '@/lib/http/clientIp';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** Nova senha a partir do link enviado por e-mail (uso único, 30 min). Encerra todas as sessões. */
export async function POST(request: Request) {
    const requestId = crypto.randomUUID();
    try {
        if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
        const body = await readJsonLimited<{ token?: unknown; newPassword?: unknown }>(request, 4 * 1024);
        if (!body || typeof body.token !== 'string' || typeof body.newPassword !== 'string') return reply({ error: 'Informe a nova senha.' }, 400);
        await resetPasswordWithToken(database(), body.token, body.newPassword, clientIp(request.headers));
        logger.info('auth.recuperacao.concluida', { requestId });
        return reply({ ok: true });
    } catch (error) {
        if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
        if (error instanceof RuleError) return reply({ error: error.message }, error.status);
        logger.error('auth.recuperacao.erro', { requestId, error });
        return reply({ error: 'Não foi possível redefinir a senha. Tente novamente.', requestId }, 503);
    }
}
