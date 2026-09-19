#!/bin/sh
# Teste de restauração (§57: "backup que nunca foi testado não é confiável"). Restaura um
# dump (o mais recente por padrão) num banco TEMPORÁRIO, confere que as tabelas foram
# recriadas e são legíveis, e apaga o banco temporário. Nunca toca o banco de produção.
# Uso: docker compose exec backup sh /scripts/restore-test.sh [/backups/omnihub-....dump]
set -eu
BACKUP_DIR="${BACKUP_DIR:-/backups}"
file="${1:-}"
if [ -z "$file" ]; then file="$(ls -1t "$BACKUP_DIR"/omnihub-*.dump 2>/dev/null | head -n 1 || true)"; fi
if [ -z "$file" ] || [ ! -s "$file" ]; then echo "FALHA: nenhum dump encontrado em $BACKUP_DIR"; exit 1; fi

db="omnihub_restore_test_$(date -u +%Y%m%d%H%M%S)"
echo "Restaurando $(basename "$file") no banco temporário $db ..."
createdb "$db"
trap 'dropdb --if-exists "$db" >/dev/null 2>&1 || true' EXIT
pg_restore --no-owner --exit-on-error --dbname="$db" "$file"

count() { psql -d "$1" -At -c "$2"; }
tables_restored="$(count "$db" "select count(*) from information_schema.tables where table_schema='public'")"
tables_live="$(count "${PGDATABASE:-omnihub}" "select count(*) from information_schema.tables where table_schema='public'")"
echo "Tabelas: restaurado=$tables_restored produção=$tables_live"
if [ "$tables_restored" != "$tables_live" ]; then echo "FALHA: quantidade de tabelas difere (o dump é anterior a uma migração?)"; exit 1; fi

for table in _migrations users accounts sales stock_movements fiscal_documents fiscal_events; do
    echo "  $table: $(count "$db" "select count(*) from $table") linhas (restaurado) / $(count "${PGDATABASE:-omnihub}" "select count(*) from $table") (produção agora)"
done
echo "OK: restauração validada. O banco temporário será apagado."
