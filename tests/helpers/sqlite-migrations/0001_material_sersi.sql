CREATE TABLE `permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_permissions_code` ON `permissions` (`code`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` text NOT NULL,
	`permission_id` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_role_permissions_unique` ON `role_permissions` (`role_id`,`permission_id`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`name` text NOT NULL,
	`is_system` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_stores` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_stores_unique` ON `user_stores` (`user_id`,`store_id`);--> statement-breakpoint
CREATE TABLE `user_tenant_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`role_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_tenant_roles_unique` ON `user_tenant_roles` (`user_id`,`tenant_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
-- Semente do catálogo de permissões (instrucoes.md §4). Mantida em espelho com
-- lib/authz/permissions.ts e lib/authz/roles.ts; qualquer alteração deve ser feita nos
-- dois lugares. `id = code` por simplicidade (não há necessidade de um id sintético).
INSERT OR IGNORE INTO permissions (id, code) VALUES
 ('STORE_VIEW','STORE_VIEW'),('STORE_CREATE','STORE_CREATE'),('STORE_EDIT','STORE_EDIT'),
 ('PRODUCT_VIEW','PRODUCT_VIEW'),('PRODUCT_CREATE','PRODUCT_CREATE'),('PRODUCT_EDIT','PRODUCT_EDIT'),('PRODUCT_DELETE','PRODUCT_DELETE'),
 ('STOCK_VIEW','STOCK_VIEW'),('STOCK_ADJUST','STOCK_ADJUST'),('STOCK_TRANSFER','STOCK_TRANSFER'),
 ('SALE_CREATE','SALE_CREATE'),('SALE_CANCEL','SALE_CANCEL'),('SALE_DISCOUNT','SALE_DISCOUNT'),
 ('CASH_OPEN','CASH_OPEN'),('CASH_CLOSE','CASH_CLOSE'),('CASH_SUPPLY','CASH_SUPPLY'),('CASH_WITHDRAWAL','CASH_WITHDRAWAL'),
 ('FISCAL_ISSUE','FISCAL_ISSUE'),('FISCAL_CANCEL','FISCAL_CANCEL'),
 ('USER_VIEW','USER_VIEW'),('USER_CREATE','USER_CREATE'),('USER_EDIT','USER_EDIT'),
 ('REPORT_VIEW','REPORT_VIEW'),
 ('AUDIT_VIEW','AUDIT_VIEW');
--> statement-breakpoint
-- Papéis de sistema (instrucoes.md §4). tenant_id NULL = papel global, não específico de
-- um tenant nesta fase (ver docs/analise-inicial.md §14/§18).
INSERT OR IGNORE INTO roles (id, tenant_id, name, is_system) VALUES
 ('ROLE_OWNER', NULL, 'OWNER', 1),
 ('ROLE_ADMIN', NULL, 'ADMIN', 1),
 ('ROLE_GERENTE', NULL, 'GERENTE', 1),
 ('ROLE_OPERADOR_CAIXA', NULL, 'OPERADOR_CAIXA', 1),
 ('ROLE_ESTOQUISTA', NULL, 'ESTOQUISTA', 1),
 ('ROLE_CONSULTA', NULL, 'CONSULTA', 1);
--> statement-breakpoint
-- Matriz padrão de permissões por papel (PROPOSTA TÉCNICA, ver lib/authz/roles.ts para
-- a justificativa de cada papel). OWNER e ADMIN recebem o catálogo inteiro.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OWNER', id FROM permissions;
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ADMIN', id FROM permissions;
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT 'ROLE_GERENTE', id FROM permissions WHERE id IN ('STORE_VIEW','PRODUCT_VIEW','PRODUCT_CREATE','PRODUCT_EDIT','STOCK_VIEW','STOCK_ADJUST','STOCK_TRANSFER','SALE_CREATE','SALE_CANCEL','SALE_DISCOUNT','CASH_OPEN','CASH_CLOSE','CASH_SUPPLY','CASH_WITHDRAWAL','USER_VIEW','REPORT_VIEW','AUDIT_VIEW');
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OPERADOR_CAIXA', id FROM permissions WHERE id IN ('STORE_VIEW','PRODUCT_VIEW','STOCK_VIEW','SALE_CREATE','CASH_OPEN','CASH_CLOSE','CASH_SUPPLY','CASH_WITHDRAWAL');
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ESTOQUISTA', id FROM permissions WHERE id IN ('STORE_VIEW','PRODUCT_VIEW','STOCK_VIEW','STOCK_ADJUST','STOCK_TRANSFER');
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT 'ROLE_CONSULTA', id FROM permissions WHERE id IN ('STORE_VIEW','PRODUCT_VIEW','STOCK_VIEW','REPORT_VIEW','AUDIT_VIEW');
--> statement-breakpoint
-- Backfill de dados existentes em `memberships` (única origem até esta migração) para as
-- tabelas normalizadas, sem apagar ou alterar `memberships`. Mapeamento de compatibilidade
-- ('admin' -> OWNER, 'operator' -> OPERADOR_CAIXA) documentado em lib/authz/roles.ts e em
-- docs/analise-inicial.md §14. Papel desconhecido cai em CONSULTA (menor privilégio) como
-- padrão seguro, nunca em um papel administrativo.
INSERT OR IGNORE INTO users (id, display_name, created_at)
SELECT user_id, display_name, unixepoch() * 1000 FROM memberships;
--> statement-breakpoint
INSERT OR IGNORE INTO user_tenant_roles (id, user_id, tenant_id, role_id)
SELECT lower(hex(randomblob(16))), user_id, account_id,
 CASE role WHEN 'admin' THEN 'ROLE_OWNER' WHEN 'operator' THEN 'ROLE_OPERADOR_CAIXA' ELSE 'ROLE_CONSULTA' END
FROM memberships;
--> statement-breakpoint
INSERT OR IGNORE INTO user_stores (id, user_id, tenant_id, store_id)
SELECT lower(hex(randomblob(16))), user_id, account_id, store_id
FROM memberships WHERE store_id IS NOT NULL;
