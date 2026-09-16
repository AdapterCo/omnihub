import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const accounts = sqliteTable('accounts', {
 id: text('id').primaryKey(), name: text('name').notNull(), state: text('state').notNull(), revision: integer('revision').notNull().default(0),
 subscriptionStatus: text('subscription_status').notNull().default('trial'), accessUntil: integer('access_until').notNull(), maxStores: integer('max_stores').notNull().default(3), createdAt: integer('created_at').notNull(),
});
export const memberships = sqliteTable('memberships', {
 userId: text('user_id').primaryKey(), accountId: text('account_id').notNull().references(()=>accounts.id), role: text('role').notNull(), storeId: text('store_id'), displayName: text('display_name').notNull(),
},table=>[uniqueIndex('idx_memberships_account_user').on(table.accountId,table.userId)]);
