#!/bin/sh
# Backup lógico do PostgreSQL do OmniHub (§57). Usa as variáveis padrão PG* (PGHOST,
# PGUSER, PGPASSWORD, PGDATABASE). O dump inclui os XMLs fiscais e os eventos, que ficam no
# banco. Fluxo: dump em arquivo temporário -> valida que o arquivo é um dump legível ->
# só então publica com o nome final -> aplica a retenção. Um dump que falhou NUNCA substitui
# nem apaga um bom, e a retenção nunca apaga os BACKUP_KEEP_MIN mais recentes.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
KEEP_MIN="${BACKUP_KEEP_MIN:-3}"

log() { printf '{"ts":"%s","level":"%s","event":"%s","detail":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3"; }

case "$RETENTION_DAYS" in ''|*[!0-9]*) log error backup.config_invalida "BACKUP_RETENTION_DAYS deve ser inteiro"; exit 2;; esac
case "$KEEP_MIN" in ''|*[!0-9]*) log error backup.config_invalida "BACKUP_KEEP_MIN deve ser inteiro"; exit 2;; esac

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%d-%H%M%S)"
tmp="$BACKUP_DIR/.omnihub-$stamp.dump.tmp"
final="$BACKUP_DIR/omnihub-$stamp.dump"
trap 'rm -f "$tmp"' EXIT

if ! pg_dump --format=custom --no-owner --file="$tmp"; then
    log error backup.dump_falhou "pg_dump retornou erro"
    exit 1
fi
if [ ! -s "$tmp" ] || ! pg_restore --list "$tmp" >/dev/null 2>&1; then
    log error backup.dump_invalido "arquivo vazio ou ilegivel"
    exit 1
fi

chmod 600 "$tmp"
mv "$tmp" "$final"
printf '%s\n' "$stamp" > "$BACKUP_DIR/latest.ok"
size="$(wc -c < "$final" | tr -d ' ')"
log info backup.ok "arquivo=$(basename "$final") bytes=$size"

# Retenção: do mais novo para o mais antigo, pula os KEEP_MIN primeiros e remove só o que
# passou de RETENTION_DAYS dias.
index=0
for file in $(ls -1t "$BACKUP_DIR"/omnihub-*.dump 2>/dev/null); do
    index=$((index + 1))
    [ "$index" -le "$KEEP_MIN" ] && continue
    if [ -n "$(find "$file" -mtime +"$RETENTION_DAYS" 2>/dev/null)" ]; then
        rm -f "$file"
        log info backup.removido_por_retencao "arquivo=$(basename "$file")"
    fi
done
