-- Dublê SQLite de drizzle/0014_platform_plans.sql (planos e assinaturas da plataforma).
CREATE TABLE platform_plans (
	id text PRIMARY KEY NOT NULL,
	name text NOT NULL,
	price_cents integer NOT NULL,
	max_stores integer NOT NULL,
	active integer DEFAULT 1 NOT NULL,
	created_by text NOT NULL,
	created_at integer NOT NULL,
	updated_at integer NOT NULL
);

CREATE TABLE platform_settings (
	key text PRIMARY KEY NOT NULL,
	value text NOT NULL,
	updated_by text NOT NULL,
	updated_at integer NOT NULL
);

CREATE TABLE account_subscriptions (
	id text PRIMARY KEY NOT NULL,
	account_id text NOT NULL REFERENCES accounts(id),
	plan_id text NOT NULL REFERENCES platform_plans(id),
	plan_name text NOT NULL,
	price_cents integer NOT NULL,
	max_stores integer NOT NULL,
	payer_email text NOT NULL,
	preapproval_id text,
	init_point text,
	status text NOT NULL,
	provider_status text DEFAULT '' NOT NULL,
	paid_until integer DEFAULT 0 NOT NULL,
	last_payment_id text,
	last_error text DEFAULT '' NOT NULL,
	created_by text NOT NULL,
	created_at integer NOT NULL,
	updated_at integer NOT NULL,
	last_checked_at integer
);
CREATE UNIQUE INDEX account_subscriptions_preapproval ON account_subscriptions (preapproval_id) WHERE preapproval_id IS NOT NULL;
CREATE INDEX account_subscriptions_account ON account_subscriptions (account_id, created_at);
CREATE INDEX account_subscriptions_status ON account_subscriptions (status, updated_at);
