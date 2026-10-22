-- Modelos de contrato de cada loja (2026-10-21): o lojista sobe o PDF do próprio contrato, o
-- sistema extrai o texto, ele marca os campos ({{cliente.nome}}...) e publica. Cada publicação é
-- uma versão imutável; contratos já gerados guardam a versão usada no snapshot. Os dois modelos
-- escritos no código (D-MAX e F C Eletrônicos) continuam valendo para lojas sem modelo próprio.
--
-- Condições do contrato (garantia, multa, juros, residual) ficam em colunas: o sistema usa esses
-- valores nos boletos, em vez de números fixos. Assinatura: identificador do modelo no Adapter
-- Sign e os papéis (empresa e cliente) lidos de lá.
CREATE TABLE contract_models (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	order_type text NOT NULL,
	name text NOT NULL,
	version bigint NOT NULL,
	status text NOT NULL,
	title text DEFAULT '' NOT NULL,
	header_text text DEFAULT '' NOT NULL,
	body text DEFAULT '' NOT NULL,
	footer_text text DEFAULT '' NOT NULL,
	logo_key text,
	logo_mime text,
	warranty_days bigint,
	fine_bp bigint,
	interest_bp bigint,
	residual_cents bigint,
	sign_template_key text DEFAULT '' NOT NULL,
	sign_company_role text DEFAULT '' NOT NULL,
	sign_client_role text DEFAULT '' NOT NULL,
	client_initials bigint DEFAULT 0 NOT NULL,
	source_filename text DEFAULT '' NOT NULL,
	created_by text NOT NULL,
	created_by_name text DEFAULT '' NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	published_at bigint,
	published_by_name text
);
CREATE INDEX contract_models_store ON contract_models (tenant_id, store_id, order_type, status);
