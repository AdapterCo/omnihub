CREATE TABLE `fiscal_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text NOT NULL,
	`environment` text DEFAULT 'homologacao' NOT NULL,
	`model` text DEFAULT '55' NOT NULL,
	`series` integer DEFAULT 1 NOT NULL,
	`crt` text DEFAULT '1_SIMPLES_NACIONAL' NOT NULL,
	`certificate_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fiscal_configurations_store_model` ON `fiscal_configurations` (`tenant_id`, `store_id`, `model`);
--> statement-breakpoint
CREATE TABLE `fiscal_certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text,
	`encrypted_data` text NOT NULL,
	`encrypted_passphrase` text NOT NULL,
	`iv` text NOT NULL,
	`salt` text NOT NULL,
	`auth_tag` text NOT NULL,
	`subject_cnpj` text NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_to` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_fiscal_certificates_tenant` ON `fiscal_certificates` (`tenant_id`);
--> statement-breakpoint
CREATE TABLE `fiscal_sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text NOT NULL,
	`model` text NOT NULL,
	`series` integer NOT NULL,
	`current_number` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fiscal_sequences_store_model_series` ON `fiscal_sequences` (`tenant_id`, `store_id`, `model`, `series`);
--> statement-breakpoint
CREATE TABLE `fiscal_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text NOT NULL,
	`sale_id` text,
	`model` text NOT NULL,
	`series` integer NOT NULL,
	`number` integer NOT NULL,
	`access_key` text NOT NULL,
	`status` text NOT NULL,
	`cstat` text,
	`xmotivo` text,
	`raw_xml` text,
	`signed_xml` text,
	`authorized_xml` text,
	`protocol_number` text,
	`issued_at` integer NOT NULL,
	`authorized_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fiscal_documents_access_key` ON `fiscal_documents` (`access_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fiscal_documents_number` ON `fiscal_documents` (`tenant_id`, `store_id`, `model`, `series`, `number`);
--> statement-breakpoint
CREATE INDEX `idx_fiscal_documents_sale` ON `fiscal_documents` (`sale_id`);
--> statement-breakpoint
CREATE TABLE `fiscal_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`fiscal_document_id` text NOT NULL,
	`type` text NOT NULL,
	`sequence_number` integer DEFAULT 1 NOT NULL,
	`cstat` text,
	`xmotivo` text,
	`protocol_number` text,
	`raw_xml` text,
	`signed_xml` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fiscal_document_id`) REFERENCES `fiscal_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_fiscal_events_doc` ON `fiscal_events` (`fiscal_document_id`);
--> statement-breakpoint
CREATE TABLE `fiscal_audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text,
	`fiscal_document_id` text,
	`operation` text NOT NULL,
	`request_payload` text,
	`response_payload` text,
	`status_code` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fiscal_document_id`) REFERENCES `fiscal_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_fiscal_audit_logs_tenant` ON `fiscal_audit_logs` (`tenant_id`, `created_at`);
