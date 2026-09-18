import { RuleError } from '../errors.ts';
import { permissionsForRole, LEGACY_ROLE_TO_SYSTEM_ROLE, type SystemRole } from './roles.ts';
import type { PermissionCode } from './permissions.ts';

export { permissionsForRole } from './roles.ts';
export type { PermissionCode } from './permissions.ts';
export type { SystemRole } from './roles.ts';

/** Central de checagem de permissão. Não usar `role === 'admin'` fora deste módulo. */
export function requirePermission(permissions: ReadonlySet<PermissionCode>, code: PermissionCode): void {
 if (!permissions.has(code)) throw new RuleError('Você não tem permissão para realizar esta operação.', 403);
}

export function hasPermission(permissions: ReadonlySet<PermissionCode>, code: PermissionCode): boolean {
 return permissions.has(code);
}

/**
 * Garante que atores vinculados a uma loja específica só movimentem sua própria loja (§4, §5).
 * Atores sem restrição de loja (storeId === null, ex.: OWNER/ADMIN global) podem acessar qualquer loja.
 */
export function requireStoreAccess(actor: { storeId?: string | null; role?: string }, targetStoreId: string): void {
 if (actor.role !== 'admin' && actor.storeId && actor.storeId !== targetStoreId) {
  throw new RuleError('Você não pode movimentar outra loja.', 403);
 }
}

/**
 * Resolve o papel de sistema a partir do valor legado gravado em `memberships.role`
 * ('admin' | 'operator'). Usado apenas onde a origem das permissões ainda é a tabela
 * legada (fallback); a origem preferencial é `user_tenant_roles` (ver loadPermissions).
 */
export function legacyRoleToSystemRole(role: string): SystemRole | undefined {
 return LEGACY_ROLE_TO_SYSTEM_ROLE[role];
}

type PermissionRow = { code: string };

/**
 * Carrega as permissões efetivas de um usuário dentro de um tenant a partir das tabelas
 * normalizadas (user_tenant_roles → roles → role_permissions → permissions). Se não
 * houver vínculo nas tabelas novas (dado ainda não migrado), cai para o mapeamento do
 * papel legado, mantendo o comportamento anterior sem quebrar contas existentes.
 */
export async function loadPermissions(
 db: D1Database,
 userId: string,
 tenantId: string,
 legacyRole: string,
): Promise<Set<PermissionCode>> {
 const rows = await db
  .prepare(
   `SELECT p.code AS code FROM user_tenant_roles utr
    JOIN role_permissions rp ON rp.role_id = utr.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE utr.user_id = ? AND utr.tenant_id = ?`,
  )
  .bind(userId, tenantId)
  .all<PermissionRow>();
 const codes = rows.results?.map((row) => row.code) ?? [];
 if (codes.length > 0) return new Set(codes as PermissionCode[]);
 const fallbackRole = legacyRoleToSystemRole(legacyRole);
 return fallbackRole ? permissionsForRole(fallbackRole) : new Set();
}
