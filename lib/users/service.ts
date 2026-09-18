import { RuleError } from '../errors.ts';
import { requirePermission } from '../authz/service.ts';
import type { Actor, TenantUser } from '../domain.ts';
import type { SystemRole } from '../authz/roles.ts';
import { getStore } from '../catalog/service.ts';

/**
 * Consulta a lista de membros vinculados ao tenant (§4, §18).
 * Exige a permissão USER_VIEW.
 */
export async function listTenantUsers(db: D1Database, tenantId: string, actor: Actor): Promise<TenantUser[]> {
 requirePermission(actor.permissions, 'USER_VIEW');
 const rows = await db
  .prepare(
   `SELECT u.id AS id, u.display_name AS displayName, u.created_at AS createdAt,
           r.name AS role, us.store_id AS storeId, s.name AS storeName
    FROM user_tenant_roles utr
    JOIN users u ON u.id = utr.user_id
    JOIN roles r ON r.id = utr.role_id
    LEFT JOIN user_stores us ON us.user_id = u.id AND us.tenant_id = utr.tenant_id
    LEFT JOIN stores s ON s.id = us.store_id
    WHERE utr.tenant_id = ?
    ORDER BY u.created_at ASC`,
  )
  .bind(tenantId)
  .all<{ id: string; displayName: string; createdAt: number; role: string; storeId: string | null; storeName: string | null }>();

 return (rows.results ?? []).map((row) => ({
  id: row.id,
  displayName: row.displayName,
  role: row.role,
  storeId: row.storeId,
  storeName: row.storeName ?? undefined,
  createdAt: row.createdAt,
 }));
}

export type AssignUserInput = {
 userId: string;
 displayName: string;
 role: SystemRole;
 storeId?: string | null;
};

/**
 * Atribui papel e opcionalmente uma loja a um membro no tenant.
 * Cria o registro se novo (USER_CREATE) ou edita se existente (USER_EDIT).
 * Sincroniza com as tabelas normalizadas (user_tenant_roles, user_stores) e com memberships.
 */
export async function assignTenantUser(
 db: D1Database,
 tenantId: string,
 input: AssignUserInput,
 actor: Actor,
 now = Date.now(),
): Promise<void> {
 if (input.role === 'OWNER') {
  throw new RuleError('Não é permitido atribuir o papel OWNER diretamente.', 400);
 }

 const existing = await db
  .prepare('SELECT role_id AS roleId FROM user_tenant_roles WHERE user_id = ? AND tenant_id = ?')
  .bind(input.userId, tenantId)
  .first<{ roleId: string }>();

 if (existing) {
  requirePermission(actor.permissions, 'USER_EDIT');
 } else {
  requirePermission(actor.permissions, 'USER_CREATE');
 }

 if (input.storeId) {
  const store = await getStore(db, tenantId, input.storeId);
  if (!store) throw new RuleError('Loja não encontrada.', 404);
 }

 const targetRole = await db
  .prepare('SELECT id FROM roles WHERE name = ? AND (tenant_id IS NULL OR tenant_id = ?)')
  .bind(input.role, tenantId)
  .first<{ id: string }>();

 if (!targetRole) {
  throw new RuleError(`Papel ${input.role} não encontrado no sistema.`, 404);
 }

 const legacyRole = input.role === 'ADMIN' ? 'admin' : 'operator';
 const storeIdVal = input.storeId || null;

 await db.batch([
  db
   .prepare('INSERT INTO users (id, display_name, created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name')
   .bind(input.userId, input.displayName.trim(), now),
  db
   .prepare('INSERT INTO user_tenant_roles (id, user_id, tenant_id, role_id) VALUES (?,?,?,?) ON CONFLICT(user_id, tenant_id) DO UPDATE SET role_id = excluded.role_id')
   .bind(crypto.randomUUID(), input.userId, tenantId, targetRole.id),
  db.prepare('DELETE FROM user_stores WHERE user_id = ? AND tenant_id = ?').bind(input.userId, tenantId),
  ...(storeIdVal
   ? [
      db
       .prepare('INSERT INTO user_stores (id, user_id, tenant_id, store_id) VALUES (?,?,?,?)')
       .bind(crypto.randomUUID(), input.userId, tenantId, storeIdVal),
     ]
   : []),
  db
   .prepare(
    `INSERT INTO memberships (user_id, account_id, role, store_id, display_name)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET account_id = excluded.account_id, role = excluded.role, store_id = excluded.store_id, display_name = excluded.display_name`,
   )
   .bind(input.userId, tenantId, legacyRole, storeIdVal, input.displayName.trim()),
 ]);
}

/**
 * Remove o vínculo de um usuário com o tenant.
 * O proprietário (OWNER) nunca pode ser removido, nem o próprio usuário pode remover a si mesmo.
 */
export async function removeTenantUser(db: D1Database, tenantId: string, targetUserId: string, actor: Actor): Promise<void> {
 requirePermission(actor.permissions, 'USER_EDIT');

 if (actor.userId === targetUserId) {
  throw new RuleError('Você não pode remover seu próprio acesso.', 400);
 }

 const target = await db
  .prepare(
   `SELECT r.name AS roleName
    FROM user_tenant_roles utr
    JOIN roles r ON r.id = utr.role_id
    WHERE utr.user_id = ? AND utr.tenant_id = ?`,
  )
  .bind(targetUserId, tenantId)
  .first<{ roleName: string }>();

 if (!target) {
  throw new RuleError('Usuário não encontrado neste tenant.', 404);
 }

 if (target.roleName === 'OWNER') {
  throw new RuleError('O proprietário da conta (OWNER) não pode ser removido.', 403);
 }

 await db.batch([
  db.prepare('DELETE FROM user_tenant_roles WHERE user_id = ? AND tenant_id = ?').bind(targetUserId, tenantId),
  db.prepare('DELETE FROM user_stores WHERE user_id = ? AND tenant_id = ?').bind(targetUserId, tenantId),
  db.prepare('DELETE FROM memberships WHERE user_id = ? AND account_id = ?').bind(targetUserId, tenantId),
 ]);
}
