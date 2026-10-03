-- Dublê SQLite de drizzle/0015_plan_details.sql.
ALTER TABLE platform_plans ADD COLUMN description text DEFAULT '' NOT NULL;
ALTER TABLE platform_plans ADD COLUMN features text DEFAULT '' NOT NULL;
