-- Limite de tentativas de login/cadastro (lib/auth/rateLimit.ts).
CREATE TABLE auth_rate_limits (
	bucket text PRIMARY KEY NOT NULL,
	count bigint NOT NULL,
	window_start bigint NOT NULL,
	locked_until bigint DEFAULT 0 NOT NULL
);
