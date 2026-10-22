-- Checklist de entrega (2026-10-22): vinculado ao pedido, assinado à parte pelo cliente no momento
-- da entrega. Os dados do pedido, do cliente e do produto vêm do próprio pedido; na entrega só se
-- marcam os itens.
--
-- checklist_templates: um modelo por loja e tipo de pedido (seções e itens, texto da declaração e
-- modelo de assinatura do Adapter Sign).
-- contracts.document_kind: o checklist gerado é um registro de "contracts" com document_kind
-- 'CHECKLIST' — reaproveita o fluxo de assinatura (envio, link, webhook, PDF assinado, evidências)
-- sem misturar com o contrato do pedido (todas as regras de contrato filtram 'CONTRATO').
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
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX checklist_templates_store_type ON checklist_templates (tenant_id, store_id, order_type);
