import { cookies } from 'next/headers';
import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { getCurrentUser, isSameOrigin, SESSION_COOKIE } from '@/app/auth';
import { changeOwnPassword } from '@/lib/auth/security';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** Troca da própria senha (exige a atual). As outras sessões do usuário são encerradas. */
export async function POST(request: Request) {
    const requestId = crypto.randomUUID();
    try {
        if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
        const user = await getCurrentUser();
        const token = (await cookies()).get(SESSION_COOKIE)?.value;
        if (!user || !token) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
        const body = await readJsonLimited<{ currentPassword?: unknown; newPassword?: unknown }>(request, 8 * 1024);
        if (!body || typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') return reply({ error: 'Informe a senha atual e a nova.' }, 400);
        await changeOwnPassword(database(), user.userId, token, { currentPassword: body.currentPassword, newPassword: body.newPassword });
        logger.info('auth.senha.trocada', { requestId, userId: user.userId });
        return reply({ ok: true });
    } catch (error) {
        if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
        if (error instanceof RuleError) return reply({ error: error.message }, error.status);
        logger.error('auth.senha.erro', { requestId, error });
        return reply({ error: 'Não foi possível trocar a senha. Tente novamente.', requestId }, 503);
    }
}
