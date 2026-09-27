-- Documentos (armazenamento de arquivos) e contratos gerados a partir dos pedidos.
--
-- documents: só metadados; o arquivo fica no armazenamento (lib/storage), referenciado por
-- storage_key gerada pelo servidor (nunca pelo nome enviado pelo usuário). Exclusão é lógica
-- (deleted_at/deleted_by): contrato e evidência nunca somem em silêncio.
-- contracts: cada geração é um registro imutável — versão do modelo, snapshot dos dados usados,
-- hash SHA-256 do PDF original. Gerar de novo cria outra revisão e marca a anterior como
-- substituída. Os campos do Adapter Sign (envelope, código de validação, status técnico) já
-- existem aqui e são preenchidos na etapa de envio para assinatura.
CREATE TABLE documents (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	customer_id text REFERENCES customers(id),
	order_id text REFERENCES orders(id),
	contract_id text,
	type text NOT NULL,
	description text NOT NULL,
	original_filename text DEFAULT '' NOT NULL,
	storage_key text NOT NULL,
	mime_type text NOT NULL,
	size bigint NOT NULL,
	sha256 text NOT NULL,
	source text NOT NULL,
	uploaded_by text NOT NULL,
	uploaded_by_name text DEFAULT '' NOT NULL,
	created_at bigint NOT NULL,
	deleted_at bigint,
	deleted_by text
);
CREATE UNIQUE INDEX idx_documents_storage_key ON documents (storage_key);
CREATE INDEX idx_documents_order ON documents (tenant_id, order_id);
CREATE INDEX idx_documents_customer ON documents (tenant_id, customer_id);

CREATE TABLE contracts (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	order_id text NOT NULL REFERENCES orders(id),
	customer_id text NOT NULL REFERENCES customers(id),
	contract_type text NOT NULL,
	template_key text NOT NULL,
	template_version bigint NOT NULL,
	revision bigint NOT NULL,
	external_ref text NOT NULL,
	internal_status text NOT NULL,
	adapter_status text DEFAULT '' NOT NULL,
	envelope_id text,
	validation_code text,
	original_document_id text NOT NULL,
	signed_document_id text,
	evidence_document_id text,
	original_sha256 text NOT NULL,
	signed_sha256 text,
	payload_snapshot text NOT NULL,
	generated_by text NOT NULL,
	generated_by_name text NOT NULL,
	generated_at bigint NOT NULL,
	sent_at bigint,
	completed_at bigint,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX idx_contracts_external_ref ON contracts (tenant_id, external_ref);
CREATE INDEX idx_contracts_order ON contracts (tenant_id, order_id);

INSERT INTO permissions (id, code) VALUES ('DOCUMENT_DELETE','DOCUMENT_DELETE') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OWNER', id FROM permissions WHERE id = 'DOCUMENT_DELETE' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ADMIN', id FROM permissions WHERE id = 'DOCUMENT_DELETE' ON CONFLICT DO NOTHING;
