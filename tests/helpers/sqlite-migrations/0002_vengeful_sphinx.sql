CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_categories_tenant` ON `categories` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `inventories` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text NOT NULL,
	`product_id` text NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inventories_quantity_non_negative" CHECK("inventories"."quantity" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inventories_store_product` ON `inventories` (`store_id`,`product_id`);--> statement-breakpoint
CREATE TABLE `product_fiscal_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`ncm` text DEFAULT '' NOT NULL,
	`cest` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT '' NOT NULL,
	`tax_code` text DEFAULT '' NOT NULL,
	`legacy_cfop` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_fiscal_profiles_product_id_unique` ON `product_fiscal_profiles` (`product_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`category_id` text,
	`sku` text NOT NULL,
	`barcode` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`cost_price` integer NOT NULL,
	`sale_price` integer NOT NULL,
	`min_stock` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_products_tenant` ON `products` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_products_tenant_sku` ON `products` (`tenant_id`,`sku`);--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text NOT NULL,
	`product_id` text NOT NULL,
	`type` text NOT NULL,
	`quantity` integer NOT NULL,
	`previous_quantity` integer NOT NULL,
	`new_quantity` integer NOT NULL,
	`reference_type` text,
	`reference_id` text,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_stock_movements_store_product` ON `stock_movements` (`store_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `idx_stock_movements_tenant` ON `stock_movements` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `stock_transfer_items` (
	`id` text PRIMARY KEY NOT NULL,
	`transfer_id` text NOT NULL,
	`product_id` text NOT NULL,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `stock_transfers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_stock_transfer_items_transfer` ON `stock_transfer_items` (`transfer_id`);--> statement-breakpoint
CREATE TABLE `stock_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`from_store_id` text NOT NULL,
	`to_store_id` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`requested_by` text NOT NULL,
	`approved_by` text,
	`received_by` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`approved_at` integer,
	`dispatched_at` integer,
	`received_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_stock_transfers_tenant` ON `stock_transfers` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `stores` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`legal_name` text DEFAULT '' NOT NULL,
	`cnpj` text DEFAULT '' NOT NULL,
	`ie` text DEFAULT '' NOT NULL,
	`regime` text DEFAULT '' NOT NULL,
	`uf` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`municipality_code` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`number` text DEFAULT '' NOT NULL,
	`district` text DEFAULT '' NOT NULL,
	`zip` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_stores_tenant` ON `stores` (`tenant_id`);