-- Schema PostgreSQL consolidado do OmniHub. Substitui o histórico de migrações SQLite/D1
-- (Cloudflare) por um schema único, já que esta é uma instalação nova em PostgreSQL sem
-- dados pré-existentes a preservar — as migrações SQLite originais ficam arquivadas em
-- tests/helpers/sqlite-migrations/ apenas como dublê da suíte de testes.
--
-- Convenção de tipos: toda coluna de timestamp em milissegundos (`*_at`) e todo valor
-- monetário em centavos usa `bigint` (o `integer` do SQLite é dinamicamente dimensionado
-- até 8 bytes; o `integer` do Postgres é fixo em 4 bytes e estouraria com um
-- `Date.now()`). Identificadores são sempre `text` (UUID gerado em JS via
-- `crypto.randomUUID()`), nunca serial/autoincrement.
--
-- LIMITAÇÃO EXPLÍCITA: este schema segue a sintaxe padrão documentada do PostgreSQL, mas
-- não foi aplicado contra um servidor Postgres real nesta sessão (sandbox sem PostgreSQL
-- disponível). Rodar `npm run db:migrate` contra a instância real da VPS é o primeiro
-- teste de verdade desta tradução de dialeto.

-- ===== RBAC / Contas =====

CREATE TABLE accounts (
	id text PRIMARY KEY NOT NULL,
	name text NOT NULL,
	state text NOT NULL,
	revision bigint DEFAULT 0 NOT NULL,
	subscription_status text DEFAULT 'trial' NOT NULL,
	access_until bigint NOT NULL,
	max_stores bigint DEFAULT 3 NOT NULL,
	created_at bigint NOT NULL
);

CREATE TABLE users (
	id text PRIMARY KEY NOT NULL,
	display_name text NOT NULL,
	email text,
	password_hash text,
	created_at bigint NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users (email);

CREATE TABLE sessions (
	token text PRIMARY KEY NOT NULL,
	user_id text NOT NULL REFERENCES users(id),
	expires_at bigint NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE memberships (
	user_id text PRIMARY KEY NOT NULL,
	account_id text NOT NULL REFERENCES accounts(id),
	role text NOT NULL,
	store_id text,
	display_name text NOT NULL
);
CREATE UNIQUE INDEX idx_memberships_account_user ON memberships (account_id, user_id);

CREATE TABLE permissions (
	id text PRIMARY KEY NOT NULL,
	code text NOT NULL
);
CREATE UNIQUE INDEX idx_permissions_code ON permissions (code);

CREATE TABLE roles (
	id text PRIMARY KEY NOT NULL,
	tenant_id text REFERENCES accounts(id),
	name text NOT NULL,
	is_system bigint DEFAULT 1 NOT NULL
);

CREATE TABLE role_permissions (
	role_id text NOT NULL REFERENCES roles(id),
	permission_id text NOT NULL REFERENCES permissions(id)
);
CREATE UNIQUE INDEX idx_role_permissions_unique ON role_permissions (role_id, permission_id);

CREATE TABLE user_tenant_roles (
	id text PRIMARY KEY NOT NULL,
	user_id text NOT NULL REFERENCES users(id),
	tenant_id text NOT NULL REFERENCES accounts(id),
	role_id text NOT NULL REFERENCES roles(id)
);
CREATE UNIQUE INDEX idx_user_tenant_roles_unique ON user_tenant_roles (user_id, tenant_id);

CREATE TABLE user_stores (
	id text PRIMARY KEY NOT NULL,
	user_id text NOT NULL REFERENCES users(id),
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL
);
CREATE UNIQUE INDEX idx_user_stores_unique ON user_stores (user_id, store_id);

-- Semente do catálogo de permissões (instrucoes.md §4), espelhando lib/authz/permissions.ts.
INSERT INTO permissions (id, code) VALUES
 ('STORE_VIEW','STORE_VIEW'),('STORE_CREATE','STORE_CREATE'),('STORE_EDIT','STORE_EDIT'),
 ('PRODUCT_VIEW','PRODUCT_VIEW'),('PRODUCT_CREATE','PRODUCT_CREATE'),('PRODUCT_EDIT','PRODUCT_EDIT'),('PRODUCT_DELETE','PRODUCT_DELETE'),
 ('STOCK_VIEW','STOCK_VIEW'),('STOCK_ADJUST','STOCK_ADJUST'),('STOCK_TRANSFER','STOCK_TRANSFER'),
 ('SALE_CREATE','SALE_CREATE'),('SALE_CANCEL','SALE_CANCEL'),('SALE_DISCOUNT','SALE_DISCOUNT'),
 ('CASH_OPEN','CASH_OPEN'),('CASH_CLOSE','CASH_CLOSE'),('CASH_SUPPLY','CASH_SUPPLY'),('CASH_WITHDRAWAL','CASH_WITHDRAWAL'),
 ('CUSTOMER_VIEW','CUSTOMER_VIEW'),('CUSTOMER_CREATE','CUSTOMER_CREATE'),('CUSTOMER_EDIT','CUSTOMER_EDIT'),
 ('SUPPLIER_VIEW','SUPPLIER_VIEW'),('SUPPLIER_CREATE','SUPPLIER_CREATE'),('SUPPLIER_EDIT','SUPPLIER_EDIT'),
 ('FISCAL_VIEW','FISCAL_VIEW'),('FISCAL_CONFIG','FISCAL_CONFIG'),('FISCAL_ISSUE','FISCAL_ISSUE'),('FISCAL_CANCEL','FISCAL_CANCEL'),
 ('USER_VIEW','USER_VIEW'),('USER_CREATE','USER_CREATE'),('USER_EDIT','USER_EDIT'),
 ('REPORT_VIEW','REPORT_VIEW'),
 ('AUDIT_VIEW','AUDIT_VIEW')
ON CONFLICT DO NOTHING;

-- Papéis de sistema (instrucoes.md §4). tenant_id NULL = papel global.
INSERT INTO roles (id, tenant_id, name, is_system) VALUES
 ('ROLE_OWNER', NULL, 'OWNER', 1),
 ('ROLE_ADMIN', NULL, 'ADMIN', 1),
 ('ROLE_GERENTE', NULL, 'GERENTE', 1),
 ('ROLE_OPERADOR_CAIXA', NULL, 'OPERADOR_CAIXA', 1),
 ('ROLE_ESTOQUISTA', NULL, 'ESTOQUISTA', 1),
 ('ROLE_CONSULTA', NULL, 'CONSULTA', 1)
ON CONFLICT DO NOTHING;

-- Matriz padrão de permissões por papel, espelhando lib/authz/roles.ts's ROLE_PERMISSIONS
-- (proposta técnica, não regra fiscal/comercial — ajustável a pedido do usuário).
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OWNER', id FROM permissions ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ADMIN', id FROM permissions ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_GERENTE', id FROM permissions WHERE id IN ('STORE_VIEW','PRODUCT_VIEW','PRODUCT_CREATE','PRODUCT_EDIT','STOCK_VIEW','STOCK_ADJUST','STOCK_TRANSFER','SALE_CREATE','SALE_CANCEL','SALE_DISCOUNT','CASH_OPEN','CASH_CLOSE','CASH_SUPPLY','CASH_WITHDRAWAL','CUSTOMER_VIEW','CUSTOMER_CREATE','CUSTOMER_EDIT','SUPPLIER_VIEW','SUPPLIER_CREATE','SUPPLIER_EDIT','FISCAL_VIEW','USER_VIEW','REPORT_VIEW','AUDIT_VIEW') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OPERADOR_CAIXA', id FROM permissions WHERE id IN ('STORE_VIEW','PRODUCT_VIEW','STOCK_VIEW','SALE_CREATE','CASH_OPEN','CASH_CLOSE','CASH_SUPPLY','CASH_WITHDRAWAL','CUSTOMER_VIEW','CUSTOMER_CREATE') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ESTOQUISTA', id FROM permissions WHERE id IN ('STORE_VIEW','PRODUCT_VIEW','STOCK_VIEW','STOCK_ADJUST','STOCK_TRANSFER','SUPPLIER_VIEW') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_CONSULTA', id FROM permissions WHERE id IN ('STORE_VIEW','PRODUCT_VIEW','STOCK_VIEW','CUSTOMER_VIEW','SUPPLIER_VIEW','FISCAL_VIEW','REPORT_VIEW','AUDIT_VIEW') ON CONFLICT DO NOTHING;

-- ===== Catálogo / Estoque =====

CREATE TABLE categories (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	name text NOT NULL
);
CREATE INDEX idx_categories_tenant ON categories (tenant_id);

CREATE TABLE stores (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	name text NOT NULL,
	legal_name text DEFAULT '' NOT NULL,
	cnpj text DEFAULT '' NOT NULL,
	ie text DEFAULT '' NOT NULL,
	regime text DEFAULT '' NOT NULL,
	uf text DEFAULT '' NOT NULL,
	city text DEFAULT '' NOT NULL,
	municipality_code text DEFAULT '' NOT NULL,
	address text DEFAULT '' NOT NULL,
	number text DEFAULT '' NOT NULL,
	district text DEFAULT '' NOT NULL,
	zip text DEFAULT '' NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX idx_stores_tenant ON stores (tenant_id);

CREATE TABLE products (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	category_id text REFERENCES categories(id),
	sku text NOT NULL,
	barcode text DEFAULT '' NOT NULL,
	name text NOT NULL,
	unit text NOT NULL,
	cost_price bigint NOT NULL,
	sale_price bigint NOT NULL,
	min_stock bigint DEFAULT 0 NOT NULL,
	active bigint DEFAULT 1 NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX idx_products_tenant ON products (tenant_id);
CREATE UNIQUE INDEX idx_products_tenant_sku ON products (tenant_id, sku);

CREATE TABLE product_fiscal_profiles (
	id text PRIMARY KEY NOT NULL,
	product_id text NOT NULL REFERENCES products(id),
	ncm text DEFAULT '' NOT NULL,
	cest text DEFAULT '' NOT NULL,
	origin text DEFAULT '' NOT NULL,
	tax_code text DEFAULT '' NOT NULL,
	legacy_cfop text DEFAULT '' NOT NULL
);
CREATE UNIQUE INDEX product_fiscal_profiles_product_id_unique ON product_fiscal_profiles (product_id);

CREATE TABLE inventories (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	product_id text NOT NULL REFERENCES products(id),
	quantity bigint DEFAULT 0 NOT NULL,
	CONSTRAINT chk_inventories_quantity_non_negative CHECK (quantity >= 0)
);
CREATE UNIQUE INDEX idx_inventories_store_product ON inventories (store_id, product_id);

CREATE TABLE stock_movements (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	product_id text NOT NULL REFERENCES products(id),
	type text NOT NULL,
	quantity bigint NOT NULL,
	previous_quantity bigint NOT NULL,
	new_quantity bigint NOT NULL,
	reference_type text,
	reference_id text,
	user_id text NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX idx_stock_movements_store_product ON stock_movements (store_id, product_id);
CREATE INDEX idx_stock_movements_tenant ON stock_movements (tenant_id);

CREATE TABLE stock_transfers (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	from_store_id text NOT NULL REFERENCES stores(id),
	to_store_id text NOT NULL REFERENCES stores(id),
	status text DEFAULT 'PENDING' NOT NULL,
	requested_by text NOT NULL,
	approved_by text,
	received_by text,
	notes text DEFAULT '' NOT NULL,
	created_at bigint NOT NULL,
	approved_at bigint,
	dispatched_at bigint,
	received_at bigint,
	cancelled_at bigint
);
CREATE INDEX idx_stock_transfers_tenant ON stock_transfers (tenant_id);

CREATE TABLE stock_transfer_items (
	id text PRIMARY KEY NOT NULL,
	transfer_id text NOT NULL REFERENCES stock_transfers(id),
	product_id text NOT NULL REFERENCES products(id),
	quantity bigint NOT NULL
);
CREATE INDEX idx_stock_transfer_items_transfer ON stock_transfer_items (transfer_id);

-- ===== PDV / Caixa =====

CREATE TABLE cash_registers (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	name text NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX idx_cash_registers_store ON cash_registers (store_id);

CREATE TABLE cash_sessions (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	cash_register_id text NOT NULL REFERENCES cash_registers(id),
	store_id text NOT NULL REFERENCES stores(id),
	user_id text NOT NULL,
	operator text NOT NULL,
	opened_at bigint NOT NULL,
	opening_amount bigint NOT NULL,
	closed_at bigint,
	counted_amount bigint,
	expected_amount bigint,
	difference bigint
);
CREATE INDEX idx_cash_sessions_store ON cash_sessions (store_id);
CREATE INDEX idx_cash_sessions_tenant ON cash_sessions (tenant_id);

CREATE TABLE cash_movements (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	cash_session_id text NOT NULL REFERENCES cash_sessions(id),
	type text NOT NULL,
	amount bigint NOT NULL,
	reason text NOT NULL,
	user_id text NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX idx_cash_movements_session ON cash_movements (cash_session_id);

CREATE TABLE sales (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	store_name text NOT NULL,
	store_cnpj text DEFAULT '' NOT NULL,
	cash_session_id text NOT NULL REFERENCES cash_sessions(id),
	user_id text NOT NULL,
	operator text NOT NULL,
	customer text DEFAULT '' NOT NULL,
	document text DEFAULT '' NOT NULL,
	status text DEFAULT 'COMPLETED' NOT NULL,
	total bigint NOT NULL,
	print_count bigint DEFAULT 0 NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX idx_sales_store ON sales (store_id);
CREATE INDEX idx_sales_tenant ON sales (tenant_id);
CREATE INDEX idx_sales_cash_session ON sales (cash_session_id);

CREATE TABLE sale_items (
	id text PRIMARY KEY NOT NULL,
	sale_id text NOT NULL REFERENCES sales(id),
	product_id text NOT NULL,
	name text NOT NULL,
	sku text NOT NULL,
	qty bigint NOT NULL,
	price bigint NOT NULL
);
CREATE INDEX idx_sale_items_sale ON sale_items (sale_id);

CREATE TABLE sale_payments (
	id text PRIMARY KEY NOT NULL,
	sale_id text NOT NULL REFERENCES sales(id),
	method text NOT NULL,
	amount bigint NOT NULL
);
CREATE INDEX idx_sale_payments_sale ON sale_payments (sale_id);

CREATE TABLE non_fiscal_receipts (
	id text PRIMARY KEY NOT NULL,
	sale_id text NOT NULL REFERENCES sales(id),
	created_at bigint NOT NULL
);
CREATE UNIQUE INDEX non_fiscal_receipts_sale_id_unique ON non_fiscal_receipts (sale_id);

-- ===== Clientes / Fornecedores =====

CREATE TABLE customers (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	name text NOT NULL,
	document text DEFAULT '' NOT NULL,
	doc_type text DEFAULT 'CPF' NOT NULL,
	ie text DEFAULT '' NOT NULL,
	ind_ie_dest text DEFAULT '9' NOT NULL,
	email text DEFAULT '' NOT NULL,
	phone text DEFAULT '' NOT NULL,
	zip text DEFAULT '' NOT NULL,
	address text DEFAULT '' NOT NULL,
	number text DEFAULT '' NOT NULL,
	complement text DEFAULT '' NOT NULL,
	district text DEFAULT '' NOT NULL,
	city text DEFAULT '' NOT NULL,
	state text DEFAULT '' NOT NULL,
	municipality_code text DEFAULT '' NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
CREATE INDEX idx_customers_tenant ON customers (tenant_id);
CREATE INDEX idx_customers_tenant_doc ON customers (tenant_id, document);

CREATE TABLE suppliers (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	name text NOT NULL,
	trade_name text DEFAULT '' NOT NULL,
	document text NOT NULL,
	doc_type text DEFAULT 'CNPJ' NOT NULL,
	ie text DEFAULT '' NOT NULL,
	email text DEFAULT '' NOT NULL,
	phone text DEFAULT '' NOT NULL,
	contact_name text DEFAULT '' NOT NULL,
	zip text DEFAULT '' NOT NULL,
	address text DEFAULT '' NOT NULL,
	number text DEFAULT '' NOT NULL,
	complement text DEFAULT '' NOT NULL,
	district text DEFAULT '' NOT NULL,
	city text DEFAULT '' NOT NULL,
	state text DEFAULT '' NOT NULL,
	municipality_code text DEFAULT '' NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
CREATE INDEX idx_suppliers_tenant ON suppliers (tenant_id);
CREATE INDEX idx_suppliers_tenant_doc ON suppliers (tenant_id, document);

-- ===== Fiscal (NF-e / NFC-e) =====

CREATE TABLE fiscal_configurations (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	environment text DEFAULT 'homologacao' NOT NULL,
	model text DEFAULT '55' NOT NULL,
	series bigint DEFAULT 1 NOT NULL,
	crt text DEFAULT '1_SIMPLES_NACIONAL' NOT NULL,
	certificate_id text,
	csc_id text,
	csc_encrypted text,
	qrcode_base_url text,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX idx_fiscal_configurations_store_model ON fiscal_configurations (tenant_id, store_id, model);

CREATE TABLE fiscal_certificates (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text REFERENCES stores(id),
	encrypted_data text NOT NULL,
	encrypted_passphrase text NOT NULL,
	iv text NOT NULL,
	salt text NOT NULL,
	auth_tag text NOT NULL,
	subject_cnpj text NOT NULL,
	valid_from bigint NOT NULL,
	valid_to bigint NOT NULL,
	fingerprint text NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX idx_fiscal_certificates_tenant ON fiscal_certificates (tenant_id);

CREATE TABLE fiscal_sequences (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	model text NOT NULL,
	series bigint NOT NULL,
	current_number bigint DEFAULT 0 NOT NULL,
	updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX idx_fiscal_sequences_store_model_series ON fiscal_sequences (tenant_id, store_id, model, series);

CREATE TABLE fiscal_documents (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	sale_id text REFERENCES sales(id),
	model text NOT NULL,
	series bigint NOT NULL,
	number bigint NOT NULL,
	access_key text NOT NULL,
	status text NOT NULL,
	cstat text,
	xmotivo text,
	raw_xml text,
	signed_xml text,
	authorized_xml text,
	protocol_number text,
	issued_at bigint NOT NULL,
	authorized_at bigint,
	cancelled_at bigint
);
CREATE UNIQUE INDEX idx_fiscal_documents_access_key ON fiscal_documents (access_key);
CREATE UNIQUE INDEX idx_fiscal_documents_number ON fiscal_documents (tenant_id, store_id, model, series, number);
CREATE INDEX idx_fiscal_documents_sale ON fiscal_documents (sale_id);

CREATE TABLE fiscal_events (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	fiscal_document_id text NOT NULL REFERENCES fiscal_documents(id),
	type text NOT NULL,
	sequence_number bigint DEFAULT 1 NOT NULL,
	cstat text,
	xmotivo text,
	protocol_number text,
	raw_xml text,
	signed_xml text,
	created_at bigint NOT NULL
);
CREATE INDEX idx_fiscal_events_doc ON fiscal_events (fiscal_document_id);

CREATE TABLE fiscal_audit_logs (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text REFERENCES stores(id),
	fiscal_document_id text REFERENCES fiscal_documents(id),
	operation text NOT NULL,
	request_payload text,
	response_payload text,
	status_code bigint,
	created_at bigint NOT NULL
);
CREATE INDEX idx_fiscal_audit_logs_tenant ON fiscal_audit_logs (tenant_id, created_at);

CREATE TABLE fiscal_inutilizations (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text NOT NULL REFERENCES stores(id),
	environment text NOT NULL,
	model text NOT NULL,
	series bigint NOT NULL,
	year bigint NOT NULL,
	number_start bigint NOT NULL,
	number_end bigint NOT NULL,
	justification text NOT NULL,
	status text NOT NULL,
	cstat text,
	xmotivo text,
	protocol_number text,
	raw_xml text,
	signed_xml text,
	created_at bigint NOT NULL,
	confirmed_at bigint
);
CREATE INDEX idx_fiscal_inutilizations_store_series ON fiscal_inutilizations (tenant_id, store_id, model, series);

CREATE TABLE fiscal_jobs (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	job_type text NOT NULL,
	sale_id text,
	store_id text,
	payload text NOT NULL,
	status text DEFAULT 'PENDING' NOT NULL,
	attempts bigint DEFAULT 0 NOT NULL,
	max_attempts bigint DEFAULT 5 NOT NULL,
	next_attempt_at bigint NOT NULL,
	last_error text,
	user_id text NOT NULL,
	correlation_id text,
	idempotency_key text NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX idx_fiscal_jobs_idempotency ON fiscal_jobs (tenant_id, idempotency_key);
CREATE INDEX idx_fiscal_jobs_status_due ON fiscal_jobs (status, next_attempt_at);
CREATE INDEX idx_fiscal_jobs_tenant ON fiscal_jobs (tenant_id);

-- ===== Auditoria / Idempotência =====

CREATE TABLE audit_logs (
	id text PRIMARY KEY NOT NULL,
	tenant_id text NOT NULL REFERENCES accounts(id),
	store_id text,
	user_id text NOT NULL,
	operator text NOT NULL,
	action text NOT NULL,
	description text NOT NULL,
	entity text,
	entity_id text,
	before_data text,
	after_data text,
	ip text,
	correlation_id text,
	created_at bigint NOT NULL
);
CREATE INDEX idx_audit_logs_tenant ON audit_logs (tenant_id);
CREATE INDEX idx_audit_logs_correlation ON audit_logs (correlation_id);

CREATE TABLE command_idempotency (
	tenant_id text NOT NULL REFERENCES accounts(id),
	key text NOT NULL,
	fingerprint text NOT NULL,
	result_id text,
	created_at bigint NOT NULL,
	PRIMARY KEY (tenant_id, key)
);
