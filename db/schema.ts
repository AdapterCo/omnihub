import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const accounts = sqliteTable('accounts', {
 id: text('id').primaryKey(), name: text('name').notNull(), state: text('state').notNull(), revision: integer('revision').notNull().default(0),
 subscriptionStatus: text('subscription_status').notNull().default('trial'), accessUntil: integer('access_until').notNull(), maxStores: integer('max_stores').notNull().default(3), createdAt: integer('created_at').notNull(),
});
export const memberships = sqliteTable('memberships', {
 userId: text('user_id').primaryKey(), accountId: text('account_id').notNull().references(()=>accounts.id), role: text('role').notNull(), storeId: text('store_id'), displayName: text('display_name').notNull(),
},table=>[uniqueIndex('idx_memberships_account_user').on(table.accountId,table.userId)]);

// Fase 1 (RBAC): tabelas normalizadas de identidade e permissões, adicionadas ao lado de
// `memberships` sem removê-la. `memberships` continua sendo a origem de account/login;
// estas tabelas passam a ser a origem das permissões centralizadas (ver lib/authz).
export const users = sqliteTable('users', {
 id: text('id').primaryKey(), displayName: text('display_name').notNull(), createdAt: integer('created_at').notNull(),
});
export const roles = sqliteTable('roles', {
 id: text('id').primaryKey(), tenantId: text('tenant_id').references(()=>accounts.id), name: text('name').notNull(), isSystem: integer('is_system').notNull().default(1),
});
export const permissions = sqliteTable('permissions', {
 id: text('id').primaryKey(), code: text('code').notNull(),
},table=>[uniqueIndex('idx_permissions_code').on(table.code)]);
export const rolePermissions = sqliteTable('role_permissions', {
 roleId: text('role_id').notNull().references(()=>roles.id), permissionId: text('permission_id').notNull().references(()=>permissions.id),
},table=>[uniqueIndex('idx_role_permissions_unique').on(table.roleId,table.permissionId)]);
export const userTenantRoles = sqliteTable('user_tenant_roles', {
 id: text('id').primaryKey(), userId: text('user_id').notNull().references(()=>users.id), tenantId: text('tenant_id').notNull().references(()=>accounts.id), roleId: text('role_id').notNull().references(()=>roles.id),
},table=>[uniqueIndex('idx_user_tenant_roles_unique').on(table.userId,table.tenantId)]);
export const userStores = sqliteTable('user_stores', {
 id: text('id').primaryKey(), userId: text('user_id').notNull().references(()=>users.id), tenantId: text('tenant_id').notNull().references(()=>accounts.id), storeId: text('store_id').notNull(),
},table=>[uniqueIndex('idx_user_stores_unique').on(table.userId,table.storeId)]);
