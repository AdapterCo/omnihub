import { cookies } from 'next/headers';
import { database } from '@/db/database';
import { getSessionUser, type SessionUser } from '@/lib/auth/service';

export const SESSION_COOKIE = 'omnihub_session';

export type CurrentUser = SessionUser;

// Lê o cookie de sessão e valida no banco (substitui o antigo getChatGPTUser, que
// confiava em headers injetados pelo proxy do ChatGPT Sites).
export async function getCurrentUser(): Promise<CurrentUser | null> {
    const store = await cookies();
    return getSessionUser(database(), store.get(SESSION_COOKIE)?.value);
}

export function sessionCookieHeader(token: string, expiresAt: number, now = Date.now()): string {
    const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookieHeader(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// Atrás de proxy reverso (Traefik) o Next enxerga http://host interno, enquanto o navegador
// envia Origin https://dominio. Compara com o host/protocolo encaminhados pelo proxy também.
export function isSameOrigin(request: Request): boolean {
    const origin = request.headers.get('origin');
    if (!origin) return false;
    const url = new URL(request.url);
    if (origin === url.origin) return true;
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
    return !!host && origin === `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`;
}
