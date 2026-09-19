import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { guardedLogin } from '@/lib/auth/service';
import { clientIp } from '@/lib/http/clientIp';
import { isSameOrigin, sessionCookieHeader } from '@/app/auth';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function POST(request: Request) {
    try {
        if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
        const body = (await request.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
        if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') return reply({ error: 'Informe e-mail e senha.' }, 400);
        const { token, expiresAt } = await guardedLogin(database(), body.email, body.password, clientIp(request.headers));
        const res = reply({ ok: true });
        res.headers.append('Set-Cookie', sessionCookieHeader(token, expiresAt));
        return res;
    } catch (error) {
        if (error instanceof RuleError) return reply({ error: error.message }, error.status);
        console.error('auth.login failed', error);
        return reply({ error: 'Não foi possível entrar. Tente novamente.' }, 503);
    }
}
