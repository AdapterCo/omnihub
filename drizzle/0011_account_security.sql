-- Segurança da conta: verificação em duas etapas (TOTP), códigos de recuperação, recuperação de
-- senha por e-mail e desafio de login com código. Tokens e códigos são guardados só como SHA-256;
-- o segredo TOTP é cifrado (AES-256-GCM, FISCAL_SECRET_KEY).
ALTER TABLE users ADD COLUMN totp_secret_enc text;
ALTER TABLE users ADD COLUMN totp_pending_enc text;
ALTER TABLE users ADD COLUMN totp_enabled_at bigint;
ALTER TABLE users ADD COLUMN totp_last_step bigint;
CREATE TABLE user_recovery_codes (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users(id),
	code_hash text NOT NULL,
	used_at bigint,
	created_at bigint NOT NULL
);
CREATE INDEX idx_user_recovery_codes_user ON user_recovery_codes (user_id);
CREATE TABLE password_resets (
	token_hash text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users(id),
	expires_at bigint NOT NULL,
	used_at bigint,
	created_at bigint NOT NULL
);
CREATE INDEX idx_password_resets_user ON password_resets (user_id);
CREATE TABLE login_challenges (
	token_hash text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users(id),
	expires_at bigint NOT NULL,
	attempts bigint NOT NULL DEFAULT 0,
	created_at bigint NOT NULL
);
