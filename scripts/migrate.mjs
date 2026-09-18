// Aplica as migrações PostgreSQL em drizzle/*.sql, em ordem, contra DATABASE_URL.
// Uso: DATABASE_URL=postgres://... node scripts/migrate.mjs
// Idempotente: mantém um registro em `_migrations` e nunca reaplica um arquivo já aplicado.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'drizzle');

async function main() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL não configurada. Defina a string de conexão do PostgreSQL antes de rodar as migrações.');
    }

    const client = new pg.Client({ connectionString });
    await client.connect();

    try {
        await client.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY NOT NULL, applied_at bigint NOT NULL)');
        const appliedRows = await client.query('SELECT name FROM _migrations');
        const applied = new Set(appliedRows.rows.map((r) => r.name));

        const files = readdirSync(MIGRATIONS_DIR)
            .filter((f) => f.endsWith('.sql'))
            .sort();

        if (!files.length) {
            console.log('Nenhum arquivo de migração encontrado em drizzle/.');
            return;
        }

        for (const file of files) {
            if (applied.has(file)) {
                console.log(`- ${file} (já aplicada)`);
                continue;
            }
            const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
            console.log(`> aplicando ${file}...`);
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('INSERT INTO _migrations (name, applied_at) VALUES ($1, $2)', [file, Date.now()]);
                await client.query('COMMIT');
                console.log(`  OK`);
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`Falha ao aplicar ${file}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        console.log('Migrações concluídas.');
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
