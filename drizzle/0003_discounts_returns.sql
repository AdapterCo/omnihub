-- Descontos (§53) e devoluções/estornos (§54).
--
-- Desconto: `sales.total` passa a ser o valor LÍQUIDO (o que foi pago); o desconto fica em
-- `sales.discount` (centavos) e é rateado por item em `sale_items.discount` (a NF-e/NFC-e
-- precisa de vDesc por item). Quem concedeu e quem autorizou ficam gravados na venda.
-- Limites de desconto por papel e por conta: NENHUM valor padrão é criado — sem linha em
-- discount_limits o limite do papel é 0 (a especificação deixa X%/Y% em aberto).
ALTER TABLE sales ADD COLUMN discount bigint DEFAULT 0 NOT NULL;
ALTER TABLE sales ADD COLUMN discount_reason text DEFAULT '' NOT NULL;
ALTER TABLE sales ADD COLUMN discount_granted_by text;
ALTER TABLE sales ADD COLUMN discount_authorized_by text;
ALTER TABLE sales ADD COLUMN discount_authorized_by_name text DEFAULT '' NOT NULL;
ALTER TABLE sales ADD COLUMN returned_total bigint DEFAULT 0 NOT NULL;
ALTER TABLE sale_items ADD COLUMN discount bigint DEFAULT 0 NOT NULL;

CREATE TABLE discount_limits (
	tenant_id text NOT NULL REFERENCES accounts(id),
	role text NOT NULL,
	max_bp bigint NOT NULL,
	updated_by text NOT NULL,
	updated_at bigint NOT NULL,
	PRIMARY KEY (tenant_id, role),
	CONSTRAINT chk_discount_limits_range CHECK (max_bp >= 0 AND max_bp <= 10000)
);

-- Devolução (§54): nunca apaga a venda. Cada devolução é um registro próprio, com itens,
-- forma de estorno e (por item) se a mercadoria voltou ao estoque.
CREATE TABLE sale_returns (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	sale_id text NOT NULL REFERENCES sales(id),
	store_id text NOT NULL REFERENCES stores(id),
	user_id text NOT NULL,
	operator text NOT NULL,
	reason text NOT NULL,
	refund_method text NOT NULL,
	total bigint NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX idx_sale_returns_sale ON sale_returns (sale_id);

CREATE TABLE sale_return_items (
	id text PRIMARY KEY NOT NULL,
	return_id text NOT NULL REFERENCES sale_returns(id),
	sale_item_id text NOT NULL REFERENCES sale_items(id),
	product_id text NOT NULL,
	name text NOT NULL,
	sku text NOT NULL,
	qty bigint NOT NULL,
	amount bigint NOT NULL,
	restock bigint DEFAULT 1 NOT NULL
);
CREATE INDEX idx_sale_return_items_item ON sale_return_items (sale_item_id);

-- Novas permissões (espelham lib/authz/permissions.ts e roles.ts).
INSERT INTO permissions (id, code) VALUES ('SALE_RETURN','SALE_RETURN'),('SALE_DISCOUNT_CONFIG','SALE_DISCOUNT_CONFIG') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OWNER', id FROM permissions WHERE id IN ('SALE_RETURN','SALE_DISCOUNT_CONFIG') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ADMIN', id FROM permissions WHERE id IN ('SALE_RETURN','SALE_DISCOUNT_CONFIG') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_GERENTE', id FROM permissions WHERE id = 'SALE_RETURN' ON CONFLICT DO NOTHING;
