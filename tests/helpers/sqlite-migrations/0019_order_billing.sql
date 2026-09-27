-- Cobranças de pedidos: nenhuma alteração de migração publicada.
CREATE TABLE order_billing_configs (
 store_id text PRIMARY KEY REFERENCES stores(id), tenant_id text NOT NULL REFERENCES accounts(id),
 environment text NOT NULL CHECK(environment IN ('SANDBOX','PRODUCTION')),
 api_key_enc text NOT NULL, webhook_secret_enc text NOT NULL, webhook_key text NOT NULL UNIQUE,
 notifications_enabled bigint NOT NULL CHECK(notifications_enabled IN (0,1)), updated_at bigint NOT NULL
);
CREATE TABLE order_receivables (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES accounts(id), store_id text NOT NULL REFERENCES stores(id),
 order_id text NOT NULL REFERENCES orders(id), customer_id text NOT NULL REFERENCES customers(id),
 kind text NOT NULL CHECK(kind IN ('INSTALLMENT','RENT','ADHESION','RESIDUAL','DAMAGE')),
 sequence bigint NOT NULL, amount bigint NOT NULL CHECK(amount > 0), due_date text NOT NULL,
 fine_bp bigint NOT NULL CHECK(fine_bp >= 0), interest_bp bigint NOT NULL CHECK(interest_bp >= 0),
 environment text NOT NULL CHECK(environment IN ('SANDBOX','PRODUCTION')),
 status text NOT NULL DEFAULT 'DRAFT', provider_status text NOT NULL DEFAULT '',
 external_ref text NOT NULL UNIQUE, provider_id text, provider_customer_id text,
 invoice_url text NOT NULL DEFAULT '', last_error text NOT NULL DEFAULT '',
 checked_at bigint, created_at bigint NOT NULL, updated_at bigint NOT NULL,
 UNIQUE(order_id, kind, sequence), UNIQUE(store_id, environment, provider_id)
);
CREATE INDEX idx_receivables_pending ON order_receivables(status, checked_at);
CREATE TABLE asaas_events (
 id text PRIMARY KEY, store_id text NOT NULL REFERENCES stores(id), event_id text NOT NULL,
 payment_id text NOT NULL, status text NOT NULL DEFAULT 'RECEIVED', attempts bigint NOT NULL DEFAULT 0,
 received_at bigint NOT NULL, UNIQUE(store_id,event_id)
);
CREATE TABLE rental_closures (
 order_id text PRIMARY KEY REFERENCES orders(id), tenant_id text NOT NULL REFERENCES accounts(id),
 type text NOT NULL CHECK(type IN ('RETURN','PURCHASE')), status text NOT NULL CHECK(status IN ('PENDING','COMPLETED')),
 effective_date text NOT NULL, assessment text NOT NULL, damage_amount bigint NOT NULL CHECK(damage_amount >= 0),
 user_id text NOT NULL, created_at bigint NOT NULL, completed_at bigint,
 processing_token text, processing_until bigint
);
ALTER TABLE contracts ADD COLUMN processing_token text;
ALTER TABLE contracts ADD COLUMN processing_until bigint;
ALTER TABLE signature_configs ADD COLUMN moto_initials bigint NOT NULL DEFAULT 0 CHECK(moto_initials IN (0,1));
ALTER TABLE signature_configs ADD COLUMN locacao_initials bigint NOT NULL DEFAULT 0 CHECK(locacao_initials IN (0,1));
