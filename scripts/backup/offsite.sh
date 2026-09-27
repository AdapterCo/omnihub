#!/bin/sh
# Executar em ambiente com rclone configurado; destino informado pelo operador, sem padrão.
# Não sincroniza exclusões. Copia conjuntos completos e confere o conteúdo remoto.
set -eu
: "${BACKUP_REMOTE:?Defina BACKUP_REMOTE, destino externo configurado no rclone}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
found=0
for manifest in "$BACKUP_DIR"/omnihub-*.sha256; do
    [ -f "$manifest" ] || continue
    name="$(basename "$manifest" .sha256)"
    (cd "$BACKUP_DIR" && sha256sum -c "$name.sha256")
    mkdir "$stage/$name"
    cp "$BACKUP_DIR/$name.dump" "$BACKUP_DIR/$name.files.tar.gz" "$manifest" "$stage/$name/"
    found=1
done
[ "$found" -eq 1 ] || { echo 'Nenhum conjunto completo para enviar'; exit 1; }
rclone copy "$stage" "$BACKUP_REMOTE" --immutable
rclone check "$stage" "$BACKUP_REMOTE" --one-way --download
echo 'OK: copia externa conferida, sem apagar historico remoto.'
