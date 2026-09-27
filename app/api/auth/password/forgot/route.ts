import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { isSameOrigin } from '@/app/auth';
import { requestPasswordReset } from '@/lib/auth/security';
import { mailerFromEnv } from '@/lib/mail';
import { clientIp } from '@/lib/http/clientIp';
import { readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { logger, pseudonym } from '@/lib/log';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
const SENT = 'Se houver uma conta com esse e-mail, enviamos um link para criar uma nova senha. Confira a caixa de entrada e o spam.';

/** "Esqueci minha senha": resposta sempre igual (não revela se o e-mail existe). */
export async function POST(request: Request) {
    const requestId = crypto.randomUUID();
    try {
        if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
        const mailer = mailerFromEnv();
        if (!mailer) return reply({ error: 'A recuperação por e-mail não está configurada neste servidor. Peça ao administrador da sua conta para redefinir seu acesso em Equipe > Definir acesso.' }, 503);
        const body = await readJsonLimited<{ email?: unknown }>(request, 4 * 1024);
        if (!body || typeof body.email !== 'string') return reply({ error: 'Informe o e-mail.' }, 400);
        try {
            await requestPasswordReset(database(), mailer, body.email, clientIp(request.headers));
        } catch (error) {
            if (error instanceof RuleError) throw error;
            // Falha de envio (SMTP fora, credencial errada): registrada para o administrador. A
            // resposta continua a mesma para não revelar se o e-mail tem conta.
            logger.error('auth.recuperacao.envio_falhou', { requestId, emailRef: pseudonym(body.email), error });
        }
        return reply({ ok: true, message: SENT });
    } catch (error) {
        if (error instanceof BodyTooLargeError) return reply({ error: error.message }, 413);
        if (error instanceof RuleError) return reply({ error: error.message }, error.status);
        logger.error('auth.recuperacao.erro', { requestId, error });
        return reply({ error: 'Não foi possível concluir. Tente novamente.', requestId }, 503);
    }
}
