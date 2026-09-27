import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { getCurrentUser, isSameOrigin } from '@/app/auth';
import { beginTwoFactorSetup, disableTwoFactor, enableTwoFactor, twoFactorStatus } from '@/lib/auth/security';
import { qrSvg } from '@/lib/payments/qrImage';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** Situação da verificação em duas etapas do próprio usuário. */
export async function GET() {
    const user = await getCurrentUser();
    if (!user) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
    return reply(await twoFactorStatus(database(), user.userId));
}

/** setup (senha) → QR + segredo; enable (código) → códigos de recuperação; disable (senha + código). */
export async function POST(request: Request) {
    const requestId = crypto.randomUUID();
    try {
        if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
        const user = await getCurrentUser();
        if (!user) return reply({ error: 'Sessão encerrada. Entre novamente.', signIn: true }, 401);
        const body = await readJsonLimited<{ action?: unknown; password?: unknown; code?: unknown }>(request, 4 * 1024);
        const db = database();
        const password = typeof body?.password === 'string' ? body.password : '';
        const code = typeof body?.code === 'string' ? body.code : '';
        if (body?.action === 'setup') {
            const setup = await beginTwoFactorSetup(db, user.userId, password);
            return reply({ secret: setup.secret, uri: setup.uri, qrSvg: await qrSvg(setup.uri) });
        }
        if (body?.action === 'enable') {
            const result = await enableTwoFactor(db, user.userId, code);
            logger.info('auth.2fa.ativada', { requestId, userId: user.userId });
            return reply(result);
        }
        if (body?.action === 'disable') {
            await disableTwoFactor(db, user.userId, { password, code });
            logger.info('auth.2fa.desativada', { requestId, userId: user.userId });
            return reply({ ok: true });
        }
        return reply({ error: 'Ação inválida.' }, 400);
    } catch (error) {
        if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
        if (error instanceof RuleError) return reply({ error: error.message }, error.status);
        logger.error('auth.2fa.erro', { requestId, error });
        return reply({ error: 'Não foi possível concluir. Tente novamente.', requestId }, 503);
    }
}
