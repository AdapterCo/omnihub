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
