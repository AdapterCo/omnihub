CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`document` text DEFAULT '' NOT NULL,
	`doc_type` text DEFAULT 'CPF' NOT NULL,
	`ie` text DEFAULT '' NOT NULL,
	`ind_ie_dest` text DEFAULT '9' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`zip` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`number` text DEFAULT '' NOT NULL,
	`complement` text DEFAULT '' NOT NULL,
	`district` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`state` text DEFAULT '' NOT NULL,
	`municipality_code` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_customers_tenant` ON `customers` (`tenant_id`);
--> statement-breakpoint
CREATE INDEX `idx_customers_tenant_doc` ON `customers` (`tenant_id`, `document`);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`trade_name` text DEFAULT '' NOT NULL,
	`document` text NOT NULL,
	`doc_type` text DEFAULT 'CNPJ' NOT NULL,
	`ie` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`contact_name` text DEFAULT '' NOT NULL,
	`zip` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`number` text DEFAULT '' NOT NULL,
	`complement` text DEFAULT '' NOT NULL,
	`district` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`state` text DEFAULT '' NOT NULL,
	`municipality_code` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_suppliers_tenant` ON `suppliers` (`tenant_id`);
--> statement-breakpoint
CREATE INDEX `idx_suppliers_tenant_doc` ON `suppliers` (`tenant_id`, `document`);
