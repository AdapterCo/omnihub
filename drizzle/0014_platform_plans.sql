-- Planos da plataforma (§43/§44): cadastrados pelo administrador da plataforma, cobrança mensal
-- recorrente pelo Mercado Pago (assinatura com pagamento pendente: o cliente paga na página do
-- Mercado Pago). Nenhum plano é pré-cadastrado.
CREATE TABLE platform_plans (
	id text PRIMARY KEY NOT NULL,
	name text NOT NULL,
	price_cents bigint NOT NULL,
	max_stores bigint NOT NULL,
	active bigint DEFAULT 1 NOT NULL,
	created_by text NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);

-- Configurações da plataforma definidas pelo administrador (ex.: limite de lojas das contas dos
-- próprios administradores, que não pagam plano).
CREATE TABLE platform_settings (
	key text PRIMARY KEY NOT NULL,
	value text NOT NULL,
	updated_by text NOT NULL,
	updated_at bigint NOT NULL
);

-- Assinatura de uma conta: guarda uma cópia do plano no momento da contratação (preço e limite
-- não mudam para quem já assinou se o plano for editado depois).
CREATE TABLE account_subscriptions (
	id text PRIMARY KEY NOT NULL,
	account_id text NOT NULL REFERENCES accounts(id),
	plan_id text NOT NULL REFERENCES platform_plans(id),
	plan_name text NOT NULL,
	price_cents bigint NOT NULL,
	max_stores bigint NOT NULL,
	payer_email text NOT NULL,
	preapproval_id text,
	init_point text,
	status text NOT NULL,
	provider_status text DEFAULT '' NOT NULL,
	paid_until bigint DEFAULT 0 NOT NULL,
	last_payment_id text,
	last_error text DEFAULT '' NOT NULL,
	created_by text NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	last_checked_at bigint
);
CREATE UNIQUE INDEX account_subscriptions_preapproval ON account_subscriptions (preapproval_id) WHERE preapproval_id IS NOT NULL;
CREATE INDEX account_subscriptions_account ON account_subscriptions (account_id, created_at);
CREATE INDEX account_subscriptions_status ON account_subscriptions (status, updated_at);

-- Sem teste grátis (decisão do usuário): conta nova nasce sem acesso até assinar um plano.
ALTER TABLE accounts ALTER COLUMN subscription_status SET DEFAULT 'none';
ALTER TABLE accounts ALTER COLUMN max_stores SET DEFAULT 0;
