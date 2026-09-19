#!/bin/sh
# Executa o backup periodicamente dentro do container `backup` (docker-compose.yml). Roda
# uma vez logo após subir e depois a cada BACKUP_INTERVAL_SECONDS (padrão 86400 = 24 h). Falha
# de um ciclo é registrada e o laço continua.
set -u
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
DELAY="${BACKUP_INITIAL_DELAY_SECONDS:-30}"
case "$INTERVAL" in ''|*[!0-9]*|0) echo '{"level":"error","event":"backup.config_invalida","detail":"BACKUP_INTERVAL_SECONDS invalido"}'; exit 2;; esac
sleep "$DELAY"
while true; do
    sh /scripts/backup.sh || echo '{"level":"error","event":"backup.ciclo_falhou"}'
    sleep "$INTERVAL"
done
