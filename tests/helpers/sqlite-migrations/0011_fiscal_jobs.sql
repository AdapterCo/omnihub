CREATE TABLE `fiscal_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`job_type` text NOT NULL,
	`sale_id` text,
	`store_id` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`user_id` text NOT NULL,
	`correlation_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fiscal_jobs_idempotency` ON `fiscal_jobs` (`tenant_id`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_fiscal_jobs_status_due` ON `fiscal_jobs` (`status`, `next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `idx_fiscal_jobs_tenant` ON `fiscal_jobs` (`tenant_id`);
