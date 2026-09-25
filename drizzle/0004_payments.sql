-- Pagamentos integrados no PDV (Mercado Pago: Pix por QR Code presencial e maquininha Point).
--
-- payment_configs: credenciais do PRÓPRIO lojista, por loja e provedor. Token de acesso e
-- segredo do webhook ficam criptografados (AES-256-GCM, mesma chave dos certificados A1).
-- webhook_key é um identificador opaco que vai na URL do webhook para saber de qual loja
-- (e com qual segredo) validar a notificação; não é segredo por si só.
CREATE TABLE payment_configs (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	provider text NOT NULL,
	access_token_enc text NOT NULL,
	webhook_secret_enc text,
	qr_external_pos_id text DEFAULT '' NOT NULL,
	default_terminal_id text DEFAULT '' NOT NULL,
	webhook_key text NOT NULL,
	updated_by text NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX idx_payment_configs_store_provider ON payment_configs (store_id, provider);
CREATE UNIQUE INDEX idx_payment_configs_webhook_key ON payment_configs (webhook_key);

-- payment_charges: cada cobrança enviada ao provedor. A venda fica PENDING_PAYMENT (estoque
-- reservado) até o provedor confirmar o pagamento do MESMO valor; nunca é concluída pelo
-- conteúdo do webhook, só por consulta autenticada ao provedor.
CREATE TABLE payment_charges (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	sale_id text NOT NULL REFERENCES sales(id),
	config_id text NOT NULL REFERENCES payment_configs(id),
	provider text NOT NULL,
	method text NOT NULL,
	amount bigint NOT NULL,
	status text NOT NULL,
	provider_order_id text,
	provider_status text DEFAULT '' NOT NULL,
	provider_status_detail text DEFAULT '' NOT NULL,
	qr_data text,
	terminal_id text,
	error text DEFAULT '' NOT NULL,
	created_by text NOT NULL,
	resolved_by text,
	resolution_note text DEFAULT '' NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	last_checked_at bigint DEFAULT 0 NOT NULL,
	paid_at bigint
);
CREATE UNIQUE INDEX idx_payment_charges_sale ON payment_charges (sale_id);
CREATE INDEX idx_payment_charges_status ON payment_charges (status);
CREATE INDEX idx_payment_charges_order ON payment_charges (provider_order_id);

INSERT INTO permissions (id, code) VALUES ('PAYMENT_CONFIG','PAYMENT_CONFIG'),('PAYMENT_RESOLVE','PAYMENT_RESOLVE') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OWNER', id FROM permissions WHERE id IN ('PAYMENT_CONFIG','PAYMENT_RESOLVE') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ADMIN', id FROM permissions WHERE id IN ('PAYMENT_CONFIG','PAYMENT_RESOLVE') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_GERENTE', id FROM permissions WHERE id = 'PAYMENT_RESOLVE' ON CONFLICT DO NOTHING;
