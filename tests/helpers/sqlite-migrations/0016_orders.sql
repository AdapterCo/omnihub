-- SOMENTE NO DUBLÊ SQLITE DE TESTE: alinha o catálogo de permissões com o schema de produção
-- (drizzle/0001_init.sql), que já semeia clientes/fornecedores/fiscal para cada papel. As
-- migrações SQLite antigas nunca semearam esses códigos, então papéis carregados do banco de
-- teste ficavam sem CUSTOMER_*/SUPPLIER_*/FISCAL_VIEW/FISCAL_CONFIG.
INSERT INTO permissions (id, code) VALUES ('CUSTOMER_VIEW','CUSTOMER_VIEW'),('CUSTOMER_CREATE','CUSTOMER_CREATE'),('CUSTOMER_EDIT','CUSTOMER_EDIT'),('SUPPLIER_VIEW','SUPPLIER_VIEW'),('SUPPLIER_CREATE','SUPPLIER_CREATE'),('SUPPLIER_EDIT','SUPPLIER_EDIT'),('FISCAL_VIEW','FISCAL_VIEW'),('FISCAL_CONFIG','FISCAL_CONFIG') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OWNER', id FROM permissions WHERE id IN ('CUSTOMER_VIEW','CUSTOMER_CREATE','CUSTOMER_EDIT','SUPPLIER_VIEW','SUPPLIER_CREATE','SUPPLIER_EDIT','FISCAL_VIEW','FISCAL_CONFIG') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ADMIN', id FROM permissions WHERE id IN ('CUSTOMER_VIEW','CUSTOMER_CREATE','CUSTOMER_EDIT','SUPPLIER_VIEW','SUPPLIER_CREATE','SUPPLIER_EDIT','FISCAL_VIEW','FISCAL_CONFIG') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_GERENTE', id FROM permissions WHERE id IN ('CUSTOMER_VIEW','CUSTOMER_CREATE','CUSTOMER_EDIT','SUPPLIER_VIEW','SUPPLIER_CREATE','SUPPLIER_EDIT','FISCAL_VIEW') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OPERADOR_CAIXA', id FROM permissions WHERE id IN ('CUSTOMER_VIEW','CUSTOMER_CREATE') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ESTOQUISTA', id FROM permissions WHERE id IN ('SUPPLIER_VIEW') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_CONSULTA', id FROM permissions WHERE id IN ('CUSTOMER_VIEW','SUPPLIER_VIEW','FISCAL_VIEW') ON CONFLICT DO NOTHING;

-- Modalidades por loja, produtos seriados (chassi/IMEI), pedidos de venda com contrato e de
-- locação, e o papel Vendedor online.
--
-- stores.modalities: lista separada por vírgula entre PDV, VENDA_CONTRATO e LOCACAO. As lojas
-- existentes continuam só com PDV (é o que elas já usam), nada muda para quem não habilitar.
-- products.kind: COMUM (PDV normal), MOTO (venda com contrato, unidade com chassi/série) ou
-- LOCACAO (equipamento de locação, unidade com IMEI). Produto não comum só sai por pedido,
-- sempre com uma unidade física identificada (product_units), nunca pela quantidade avulsa.
ALTER TABLE stores ADD COLUMN modalities text DEFAULT 'PDV' NOT NULL;
ALTER TABLE products ADD COLUMN kind text DEFAULT 'COMUM' NOT NULL;

CREATE TABLE product_units (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	product_id text NOT NULL REFERENCES products(id),
	serial text NOT NULL,
	color text DEFAULT '' NOT NULL,
	memory text DEFAULT '' NOT NULL,
	condition text DEFAULT '' NOT NULL,
	status text DEFAULT 'AVAILABLE' NOT NULL,
	order_id text,
	created_by text NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX idx_product_units_serial ON product_units (tenant_id, serial);
CREATE INDEX idx_product_units_product ON product_units (tenant_id, product_id, status);

CREATE TABLE orders (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	number bigint NOT NULL,
	type text NOT NULL,
	status text DEFAULT 'OPEN' NOT NULL,
	customer_id text NOT NULL REFERENCES customers(id),
	seller_id text NOT NULL,
	seller_name text NOT NULL,
	product_id text NOT NULL REFERENCES products(id),
	unit_id text NOT NULL REFERENCES product_units(id),
	total bigint DEFAULT 0 NOT NULL,
	purchase_date text DEFAULT '' NOT NULL,
	down_payment bigint DEFAULT 0 NOT NULL,
	down_payment_method text DEFAULT '' NOT NULL,
	installments bigint DEFAULT 0 NOT NULL,
	first_due_date text DEFAULT '' NOT NULL,
	cash_payment_method text DEFAULT '' NOT NULL,
	adhesion_amount bigint DEFAULT 0 NOT NULL,
	adhesion_billing text DEFAULT '' NOT NULL,
	adhesion_payment_method text DEFAULT '' NOT NULL,
	monthly_amount bigint DEFAULT 0 NOT NULL,
	due_day bigint DEFAULT 0 NOT NULL,
	sale_id text,
	cancel_reason text DEFAULT '' NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	completed_at bigint,
	completed_by text,
	cancelled_at bigint,
	cancelled_by text
);
CREATE UNIQUE INDEX idx_orders_number ON orders (tenant_id, number);
CREATE INDEX idx_orders_store ON orders (tenant_id, store_id, status);
CREATE INDEX idx_orders_customer ON orders (tenant_id, customer_id);

CREATE TABLE order_notes (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	order_id text NOT NULL REFERENCES orders(id),
	user_id text NOT NULL,
	author text NOT NULL,
	text text NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX idx_order_notes_order ON order_notes (order_id);

INSERT INTO permissions (id, code) VALUES ('ORDER_VIEW','ORDER_VIEW'),('ORDER_CREATE','ORDER_CREATE'),('ORDER_COMPLETE','ORDER_COMPLETE'),('ORDER_CANCEL','ORDER_CANCEL') ON CONFLICT DO NOTHING;
INSERT INTO roles (id, tenant_id, name, is_system) VALUES ('ROLE_VENDEDOR_ONLINE', NULL, 'VENDEDOR_ONLINE', 1) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OWNER', id FROM permissions WHERE id IN ('ORDER_VIEW','ORDER_CREATE','ORDER_COMPLETE','ORDER_CANCEL') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ADMIN', id FROM permissions WHERE id IN ('ORDER_VIEW','ORDER_CREATE','ORDER_COMPLETE','ORDER_CANCEL') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_GERENTE', id FROM permissions WHERE id IN ('ORDER_VIEW','ORDER_CREATE','ORDER_COMPLETE','ORDER_CANCEL') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OPERADOR_CAIXA', id FROM permissions WHERE id IN ('ORDER_VIEW','ORDER_COMPLETE') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_CONSULTA', id FROM permissions WHERE id = 'ORDER_VIEW' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_VENDEDOR_ONLINE', id FROM permissions WHERE id IN ('STORE_VIEW','PRODUCT_VIEW','STOCK_VIEW','CUSTOMER_VIEW','CUSTOMER_CREATE','CUSTOMER_EDIT','ORDER_VIEW','ORDER_CREATE','ORDER_COMPLETE','ORDER_CANCEL','SALE_CREATE','CASH_OPEN','CASH_CLOSE','FISCAL_VIEW','FISCAL_ISSUE') ON CONFLICT DO NOTHING;
