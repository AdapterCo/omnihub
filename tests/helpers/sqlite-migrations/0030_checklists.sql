-- Dublê SQLite de drizzle/0019_checklists.sql.
ALTER TABLE contracts ADD COLUMN document_kind text DEFAULT 'CONTRATO' NOT NULL;

CREATE TABLE checklist_templates (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	order_type text NOT NULL,
	title text NOT NULL,
	items text NOT NULL,
	declaration text DEFAULT '' NOT NULL,
	sign_template_key text DEFAULT '' NOT NULL,
	sign_company_role text DEFAULT '' NOT NULL,
	sign_client_role text DEFAULT '' NOT NULL,
	updated_by_name text DEFAULT '' NOT NULL,
	created_at integer NOT NULL,
	updated_at integer NOT NULL
);
CREATE UNIQUE INDEX checklist_templates_store_type ON checklist_templates (tenant_id, store_id, order_type);
