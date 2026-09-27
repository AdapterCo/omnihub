-- A tela carrega janelas recentes (por conta + data) e pagina o histórico: índices compostos.
CREATE INDEX IF NOT EXISTS idx_sales_tenant_created ON sales (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_tenant_opened ON cash_sessions (tenant_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs (tenant_id, created_at);
