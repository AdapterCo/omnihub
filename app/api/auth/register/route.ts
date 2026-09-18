import { database } from '@/db/database';
import { RuleError } from '@/lib/domain';
import { registerAccount } from '@/lib/auth/service';
import { sessionCookieHeader } from '@/app/auth';

export const dynamic = 'force-dynamic';
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function POST(request: Request) {
    try {
        const origin = request.headers.get('origin');
        if (!origin || origin !== new URL(request.url).origin) return reply({ error: 'Origem da solicitação inválida.' }, 403);
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body || typeof body.accountName !== 'string' || typeof body.displayName !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') {
            return reply({ error: 'Informe nome da conta, seu nome, e-mail e senha.' }, 400);
        }
        const { token, expiresAt } = await registerAccount(database(), {
            accountName: body.accountName,
            displayName: body.displayName,
            email: body.email,
            password: body.password,
        });
        const res = reply({ ok: true }, 201);
        res.headers.append('Set-Cookie', sessionCookieHeader(token, expiresAt));
        return res;
    } catch (error) {
        if (error instanceof RuleError) return reply({ error: error.message }, error.status);
        console.error('auth.register failed', error);
        return reply({ error: 'Não foi possível criar a conta. Tente novamente.' }, 503);
    }
}
