-- Dublê SQLite de drizzle/0016_platform_invoices.sql.
CREATE TABLE platform_invoices (
	id text PRIMARY KEY NOT NULL,
	account_id text NOT NULL REFERENCES accounts(id),
	plan_id text NOT NULL REFERENCES platform_plans(id),
	plan_name text NOT NULL,
	amount_cents integer NOT NULL,
	max_stores integer NOT NULL,
	status text NOT NULL,
	payment_method text DEFAULT '' NOT NULL,
	mp_payment_id text,
	mp_status text DEFAULT '' NOT NULL,
	mp_status_detail text DEFAULT '' NOT NULL,
	period_end integer,
	due_date integer NOT NULL,
	paid_at integer,
	created_by text NOT NULL,
	created_at integer NOT NULL,
	updated_at integer NOT NULL,
	last_checked_at integer
);
CREATE INDEX platform_invoices_account ON platform_invoices (account_id, created_at);
CREATE INDEX platform_invoices_status ON platform_invoices (status, last_checked_at);
CREATE INDEX platform_invoices_payment ON platform_invoices (mp_payment_id);

DROP TABLE account_subscriptions;
