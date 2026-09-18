CREATE TABLE `fiscal_inutilizations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text NOT NULL,
	`environment` text NOT NULL,
	`model` text NOT NULL,
	`series` integer NOT NULL,
	`year` integer NOT NULL,
	`number_start` integer NOT NULL,
	`number_end` integer NOT NULL,
	`justification` text NOT NULL,
	`status` text NOT NULL,
	`cstat` text,
	`xmotivo` text,
	`protocol_number` text,
	`raw_xml` text,
	`signed_xml` text,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_fiscal_inutilizations_store_series` ON `fiscal_inutilizations` (`tenant_id`, `store_id`, `model`, `series`);
