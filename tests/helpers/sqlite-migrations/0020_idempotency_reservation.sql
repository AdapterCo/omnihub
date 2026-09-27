-- Idempotência com reserva: a chave é gravada ANTES de executar o comando (completed_at nulo =
-- em andamento). Registros antigos já estavam concluídos.
ALTER TABLE command_idempotency ADD COLUMN completed_at bigint;
UPDATE command_idempotency SET completed_at = created_at WHERE completed_at IS NULL;
CREATE INDEX idx_command_idempotency_created ON command_idempotency (created_at);
