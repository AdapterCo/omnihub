-- Integração com o Adapter Sign (assinatura eletrônica dos contratos).
--
-- signature_configs: por loja (cada loja é uma organização no Adapter Sign). API key e segredo do
-- webhook ficam cifrados (mesma chave dos certificados/pagamentos). Os identificadores dos modelos
-- no Adapter Sign são informados pela loja — não há valor padrão presumido. webhook_key é um
-- identificador opaco na URL do webhook, para saber com qual segredo validar.
-- adapter_sign_events: eventos recebidos, deduplicados pelo X-Adapter-Event-ID.
-- contracts: dados do envio (signatários, documento no Adapter Sign, quem enviou) para retomar
-- retentativas e baixar o PDF final e as evidências.
CREATE TABLE signature_configs (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	api_key_enc text NOT NULL,
	webhook_secret_enc text,
	webhook_key text NOT NULL,
	moto_template text DEFAULT '' NOT NULL,
	locacao_template text DEFAULT '' NOT NULL,
	updated_by text NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX idx_signature_configs_store ON signature_configs (store_id);
CREATE UNIQUE INDEX idx_signature_configs_webhook_key ON signature_configs (webhook_key);

CREATE TABLE adapter_sign_events (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	event_id text NOT NULL,
	event_type text NOT NULL,
	envelope_id text DEFAULT '' NOT NULL,
	external_ref text DEFAULT '' NOT NULL,
	status text DEFAULT 'RECEIVED' NOT NULL,
	error text DEFAULT '' NOT NULL,
	attempts bigint DEFAULT 0 NOT NULL,
	received_at bigint NOT NULL,
	processed_at bigint
);
CREATE UNIQUE INDEX idx_adapter_sign_events_event ON adapter_sign_events (store_id, event_id);
CREATE INDEX idx_adapter_sign_events_status ON adapter_sign_events (status);

ALTER TABLE contracts ADD COLUMN adapter_document_id text;
ALTER TABLE contracts ADD COLUMN signer_loja_id text;
ALTER TABLE contracts ADD COLUMN signer_cliente_id text;
ALTER TABLE contracts ADD COLUMN sent_by text;
ALTER TABLE contracts ADD COLUMN sent_by_name text;
ALTER TABLE contracts ADD COLUMN sent_by_email text;
ALTER TABLE contracts ADD COLUMN send_attempts bigint DEFAULT 0 NOT NULL;
ALTER TABLE contracts ADD COLUMN last_error text DEFAULT '' NOT NULL;
ALTER TABLE contracts ADD COLUMN last_checked_at bigint;
CREATE INDEX idx_contracts_status ON contracts (internal_status);
CREATE INDEX idx_contracts_envelope ON contracts (envelope_id);

INSERT INTO permissions (id, code) VALUES ('SIGNATURE_CONFIG','SIGNATURE_CONFIG') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OWNER', id FROM permissions WHERE id = 'SIGNATURE_CONFIG' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ADMIN', id FROM permissions WHERE id = 'SIGNATURE_CONFIG' ON CONFLICT DO NOTHING;
