import { getCurrentUser } from '@/app/auth';
import { database } from '@/db/database';
import { loadPermissions } from '@/lib/authz/service';
import type { Actor, Entitlement } from '@/lib/domain';
import { resolveEntitlement } from '@/lib/subscriptions/service';

// Resolve usuário da sessão → conta (tenant) → actor com permissões, para rotas fora de
// /api/workspace (ex.: upload/download de documentos). Mesma regra de app/api/workspace/route.ts.
export async function resolveWorkspaceSession(): Promise<{ tenantId: string; actor: Actor; plan: Entitlement } | null> {
 const user = await getCurrentUser();
 if (!user) return null;
 const row = await database()
  .prepare('SELECT a.id AS id, a.subscription_status AS status, a.access_until AS accessUntil, a.max_stores AS maxStores, m.role AS role, m.store_id AS storeId, m.display_name AS displayName FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.user_id = ?')
  .bind(user.userId)
  .first<{ id: string; status: string; accessUntil: number; maxStores: number; role: string; storeId: string | null; displayName: string }>();
 if (!row) return null;
 const permissions = await loadPermissions(database(), user.userId, row.id, row.role);
 return {
  tenantId: row.id,
  actor: { userId: user.userId, role: row.role, storeId: row.storeId, displayName: row.displayName, permissions },
  plan: await resolveEntitlement(database(), row.id, { status: row.status, accessUntil: Number(row.accessUntil), maxStores: Number(row.maxStores) }),
 };
}
