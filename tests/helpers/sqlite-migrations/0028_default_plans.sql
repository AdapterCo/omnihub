-- Dublê SQLite de drizzle/0017_default_plans.sql.
INSERT INTO platform_plans (id, name, price_cents, max_stores, active, created_by, created_at, updated_at, description, features)
SELECT 'plano-essencial', 'Essencial', 4990, 1, 1, 'system', 1791133200000, 1791133200000, '', ''
WHERE NOT EXISTS (SELECT 1 FROM platform_plans WHERE lower(name) = 'essencial');

INSERT INTO platform_plans (id, name, price_cents, max_stores, active, created_by, created_at, updated_at, description, features)
SELECT 'plano-profissional', 'Profissional', 8990, 3, 1, 'system', 1791133200000, 1791133200000, '', ''
WHERE NOT EXISTS (SELECT 1 FROM platform_plans WHERE lower(name) = 'profissional');

INSERT INTO platform_plans (id, name, price_cents, max_stores, active, created_by, created_at, updated_at, description, features)
SELECT 'plano-empresarial', 'Empresarial', 19990, 10, 1, 'system', 1791133200000, 1791133200000, '', ''
WHERE NOT EXISTS (SELECT 1 FROM platform_plans WHERE lower(name) = 'empresarial');
