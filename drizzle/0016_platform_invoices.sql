-- Pagamento do plano na própria tela (modelo do Adapter Connect): cada mês é uma fatura paga por Pix
-- ou cartão (API de pagamentos do Mercado Pago). Substitui a assinatura recorrente (preapproval).
CREATE TABLE platform_invoices (
	id text PRIMARY KEY NOT NULL,
	account_id text NOT NULL REFERENCES accounts(id),
	plan_id text NOT NULL REFERENCES platform_plans(id),
	plan_name text NOT NULL,
	amount_cents bigint NOT NULL,
	max_stores bigint NOT NULL,
	status text NOT NULL,
	payment_method text DEFAULT '' NOT NULL,
	mp_payment_id text,
	mp_status text DEFAULT '' NOT NULL,
	mp_status_detail text DEFAULT '' NOT NULL,
	period_end bigint,
	due_date bigint NOT NULL,
	paid_at bigint,
	created_by text NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	last_checked_at bigint
);
CREATE INDEX platform_invoices_account ON platform_invoices (account_id, created_at);
CREATE INDEX platform_invoices_status ON platform_invoices (status, last_checked_at);
CREATE INDEX platform_invoices_payment ON platform_invoices (mp_payment_id);

DROP TABLE account_subscriptions;
