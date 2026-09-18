ALTER TABLE `audit_logs` ADD `entity` text;
--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `entity_id` text;
--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `before_data` text;
--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `after_data` text;
--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `ip` text;
--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `correlation_id` text;
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_correlation` ON `audit_logs` (`correlation_id`);
