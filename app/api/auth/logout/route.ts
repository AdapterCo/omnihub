import { cookies } from 'next/headers';
import { database } from '@/db/database';
import { deleteSession } from '@/lib/auth/service';
import { SESSION_COOKIE, clearSessionCookieHeader, isSameOrigin } from '@/app/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    if (!isSameOrigin(request)) return Response.json({ error: 'Origem da solicitação inválida.' }, { status: 403 });
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (token) await deleteSession(database(), token);
    const res = Response.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
    res.headers.append('Set-Cookie', clearSessionCookieHeader());
    return res;
}
