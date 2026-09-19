import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { guardedRegister } from '@/lib/auth/service';
import { clientIp } from '@/lib/http/clientIp';
import { isSameOrigin, sessionCookieHeader } from '@/app/auth';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function POST(request: Request) {
    try {
        if (!isSameOrigin(request)) return reply({ error: 'Origem da solicitação inválida.' }, 403);
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body || typeof body.accountName !== 'string' || typeof body.displayName !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') {
            return reply({ error: 'Informe nome da conta, seu nome, e-mail e senha.' }, 400);
        }
        const { token, expiresAt } = await guardedRegister(
            database(),
            { accountName: body.accountName, displayName: body.displayName, email: body.email, password: body.password },
            clientIp(request.headers),
        );
        const res = reply({ ok: true }, 201);
        res.headers.append('Set-Cookie', sessionCookieHeader(token, expiresAt));
        return res;
    } catch (error) {
        if (error instanceof RuleError) return reply({ error: error.message }, error.status);
        console.error('auth.register failed', error);
        return reply({ error: 'Não foi possível criar a conta. Tente novamente.' }, 503);
    }
}
