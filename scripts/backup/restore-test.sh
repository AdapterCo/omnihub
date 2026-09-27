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

# Confere os arquivos do mesmo conjunto e cada hash armazenado no banco restaurado.
archive="${file%.dump}.files.tar.gz"
if [ -n "${STORAGE_DIR:-}" ]; then
    [ -s "$archive" ] && [ -s "${file%.dump}.sha256" ] || { echo 'FALHA: backup de arquivos/manifesto ausente'; exit 1; }
    (cd "$(dirname "$file")" && sha256sum -c "$(basename "${file%.dump}.sha256")")
    restored_files="$(mktemp -d)"
    trap 'dropdb --if-exists "$db" >/dev/null 2>&1 || true; rm -rf "$restored_files"' EXIT
    # Defesa contra arquivo tar externo com caminhos absolutos/traversal ou symlinks.
    # Nome relativo ao diretório do dump: o tar interpreta "C:/..." como host remoto.
    cd "$(dirname "$archive")"; archive="$(basename "$archive")"
    tar -tzf "$archive" | grep -E '(^/|(^|/)\.\.(/|$))' && { echo 'FALHA: caminho inseguro no tar'; exit 1; }
    tar -tvzf "$archive" | grep '^l' && { echo 'FALHA: link simbolico no tar'; exit 1; }
    tar -xzf "$archive" -C "$restored_files"
    psql -d "$db" -At -F '|' -c 'SELECT storage_key,sha256 FROM documents' > "$restored_files/objects.list"
    while IFS='|' read -r key expected; do
        case "$key" in /*|*..*) echo 'FALHA: chave insegura'; exit 1;; esac
        actual="$(sha256sum "$restored_files/$key" | cut -d ' ' -f 1)"
        [ "$actual" = "$expected" ] || { echo 'FALHA: documento ausente/corrompido'; exit 1; }
    done < "$restored_files/objects.list"
    echo 'OK: hashes dos documentos restaurados conferidos.'
fi

count() { psql -d "$1" -At -c "$2"; }
tables_restored="$(count "$db" "select count(*) from information_schema.tables where table_schema='public'")"
tables_live="$(count "${PGDATABASE:-omnihub}" "select count(*) from information_schema.tables where table_schema='public'")"
echo "Tabelas: restaurado=$tables_restored produção=$tables_live"
if [ "$tables_restored" != "$tables_live" ]; then echo "FALHA: quantidade de tabelas difere (o dump é anterior a uma migração?)"; exit 1; fi

for table in _migrations users accounts sales stock_movements fiscal_documents fiscal_events; do
    echo "  $table: $(count "$db" "select count(*) from $table") linhas (restaurado) / $(count "${PGDATABASE:-omnihub}" "select count(*) from $table") (produção agora)"
done
echo "OK: restauração validada. O banco temporário será apagado."
