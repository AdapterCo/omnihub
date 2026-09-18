CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text,
	`user_id` text NOT NULL,
	`operator` text NOT NULL,
	`action` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_tenant` ON `audit_logs` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `command_idempotency` (
	`tenant_id` text NOT NULL,
	`key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`result_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `key`),
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
