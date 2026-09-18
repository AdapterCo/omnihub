CREATE TABLE `cash_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`cash_session_id` text NOT NULL,
	`type` text NOT NULL,
	`amount` integer NOT NULL,
	`reason` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_session_id`) REFERENCES `cash_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_cash_movements_session` ON `cash_movements` (`cash_session_id`);--> statement-breakpoint
CREATE TABLE `cash_registers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_cash_registers_store` ON `cash_registers` (`store_id`);--> statement-breakpoint
CREATE TABLE `cash_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`cash_register_id` text NOT NULL,
	`store_id` text NOT NULL,
	`user_id` text NOT NULL,
	`operator` text NOT NULL,
	`opened_at` integer NOT NULL,
	`opening_amount` integer NOT NULL,
	`closed_at` integer,
	`counted_amount` integer,
	`expected_amount` integer,
	`difference` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_register_id`) REFERENCES `cash_registers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_cash_sessions_store` ON `cash_sessions` (`store_id`);--> statement-breakpoint
CREATE INDEX `idx_cash_sessions_tenant` ON `cash_sessions` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `non_fiscal_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `non_fiscal_receipts_sale_id_unique` ON `non_fiscal_receipts` (`sale_id`);--> statement-breakpoint
CREATE TABLE `sale_items` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`sku` text NOT NULL,
	`qty` integer NOT NULL,
	`price` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sale_items_sale` ON `sale_items` (`sale_id`);--> statement-breakpoint
CREATE TABLE `sale_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`method` text NOT NULL,
	`amount` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sale_payments_sale` ON `sale_payments` (`sale_id`);--> statement-breakpoint
CREATE TABLE `sales` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text NOT NULL,
	`store_name` text NOT NULL,
	`store_cnpj` text DEFAULT '' NOT NULL,
	`cash_session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`operator` text NOT NULL,
	`customer` text DEFAULT '' NOT NULL,
	`document` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'COMPLETED' NOT NULL,
	`total` integer NOT NULL,
	`print_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_session_id`) REFERENCES `cash_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sales_store` ON `sales` (`store_id`);--> statement-breakpoint
CREATE INDEX `idx_sales_tenant` ON `sales` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_sales_cash_session` ON `sales` (`cash_session_id`);