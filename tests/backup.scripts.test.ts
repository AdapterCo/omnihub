import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Testa a LÓGICA de scripts/backup/backup.sh (nome, publicação atômica, validação,
// retenção) com `pg_dump`/`pg_restore` SIMULADOS (mock explícito: não há PostgreSQL nem
// pg_dump nos testes). A execução real contra o banco só é validável na VPS/Docker.
const script = join(process.cwd(), 'scripts', 'backup', 'backup.sh');
const shAvailable = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const posix = (p: string) => p.replace(/\\/g, '/');

const MOCK_MARKER = 'PGDMP-mock-dump';
const PG_DUMP_OK = ['#!/bin/sh', 'for a in "$@"; do case "$a" in --file=*) f="${a#--file=}";; esac; done', `printf "${MOCK_MARKER}" > "$f"`, ''].join('\n');
const PG_DUMP_FAIL = '#!/bin/sh\nexit 3\n';
const PG_RESTORE_OK = `#!/bin/sh\ngrep -q ${MOCK_MARKER} "$2"\n`;
const PG_RESTORE_FAIL = '#!/bin/sh\nexit 1\n';

function setup(options: { dumpFails?: boolean; invalidDump?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'omnihub-backup-'));
    const bin = join(root, 'bin');
    const backups = join(root, 'backups');
    mkdirSync(bin);
    mkdirSync(backups);
    writeFileSync(join(bin, 'pg_dump'), options.dumpFails ? PG_DUMP_FAIL : PG_DUMP_OK);
    writeFileSync(join(bin, 'pg_restore'), options.invalidDump ? PG_RESTORE_FAIL : PG_RESTORE_OK);
    chmodSync(join(bin, 'pg_dump'), 0o755);
    chmodSync(join(bin, 'pg_restore'), 0o755);
    const run = (extra: Record<string, string> = {}) =>
        spawnSync('sh', [posix(script)], { encoding: 'utf8', env: { ...process.env, PATH: `${posix(bin)}:${process.env.PATH}`, BACKUP_DIR: posix(backups), ...extra } });
    return { backups, run };
}
const dumps = (dir: string) => readdirSync(dir).filter((f) => /^omnihub-.*\.dump$/.test(f));

test('backup.sh publica o dump com nome final, marca latest.ok e não deixa temporários', { skip: !shAvailable }, () => {
    const { backups, run } = setup();
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dumps(backups).length, 1);
    assert.ok(existsSync(join(backups, 'latest.ok')));
    assert.deepEqual(readdirSync(backups).filter((f) => f.endsWith('.tmp')), []);
    assert.match(result.stdout, /backup\.ok/);
});

test('backup.sh: pg_dump falhando não cria arquivo e não apaga backups bons existentes', { skip: !shAvailable }, () => {
    const { backups, run } = setup({ dumpFails: true });
    writeFileSync(join(backups, 'omnihub-20200101-000000.dump'), MOCK_MARKER);
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /backup\.dump_falhou/);
    assert.deepEqual(dumps(backups), ['omnihub-20200101-000000.dump']);
});

test('backup.sh: dump ilegível (pg_restore --list falha) é descartado e não vira backup', { skip: !shAvailable }, () => {
    const { backups, run } = setup({ invalidDump: true });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /backup\.dump_invalido/);
    assert.deepEqual(readdirSync(backups), []);
});

test('backup.sh: retenção remove só o que passou do prazo e nunca os KEEP_MIN mais recentes', { skip: !shAvailable }, () => {
    const { backups, run } = setup();
    const day = 24 * 60 * 60 * 1000;
    const names = ['omnihub-20200101-000000.dump', 'omnihub-20200102-000000.dump', 'omnihub-20200103-000000.dump', 'omnihub-20200104-000000.dump', 'omnihub-20200105-000000.dump'];
    names.forEach((name, i) => {
        writeFileSync(join(backups, name), MOCK_MARKER);
        const when = new Date(Date.now() - (60 - i) * day); // todos muito antigos (> 14 dias)
        utimesSync(join(backups, name), when, when);
    });
    const result = run({ BACKUP_RETENTION_DAYS: '14', BACKUP_KEEP_MIN: '3' });
    assert.equal(result.status, 0, result.stderr);
    const left = dumps(backups);
    // O dump novo + os 2 mais recentes dos antigos = 3 (KEEP_MIN); os 3 mais antigos saem.
    assert.equal(left.length, 3, `restaram: ${left.join(', ')}`);
    assert.ok(!left.includes(names[0]) && !left.includes(names[1]) && !left.includes(names[2]));
    assert.ok(left.includes(names[3]) && left.includes(names[4]));
});

test('backup.sh: backups recentes são preservados mesmo além de KEEP_MIN; configuração inválida aborta sem dump', { skip: !shAvailable }, () => {
    const { backups, run } = setup();
    for (let i = 1; i <= 5; i++) writeFileSync(join(backups, `omnihub-2099010${i}-000000.dump`), MOCK_MARKER);
    assert.equal(run({ BACKUP_RETENTION_DAYS: '14', BACKUP_KEEP_MIN: '1' }).status, 0);
    assert.equal(dumps(backups).length, 6);
    const bad = run({ BACKUP_RETENTION_DAYS: 'abc' });
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /config_invalida/);
    assert.equal(dumps(backups).length, 6);
});
