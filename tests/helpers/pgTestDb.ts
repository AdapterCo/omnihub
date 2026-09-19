import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { createPostgresD1Adapter } from '../../lib/db/pgAdapter.ts';

/**
 * Modo opcional dos testes: em vez do dublê SQLite, roda contra um PostgreSQL REAL, com o
 * schema de produção (`drizzle/*.sql`). Cada chamada cria um schema próprio (isolamento
 * entre testes). Ativado por `TEST_DATABASE_URL`; sem ela a suíte usa o SQLite em memória.
 * Existe porque o dublê SQLite esconde diferenças de dialeto (ex.: caixa de apelidos).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'drizzle');

export function createPgTestDb(url: string, migrationFiles: string[]): D1Database {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4, idleTimeoutMillis: 200, allowExitOnIdle: true });
    const inner = createPostgresD1Adapter(pool);
    const ready = (async () => {
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        try {
            await client.query(`CREATE SCHEMA ${schema}`);
            await client.query(`SET search_path TO ${schema}`);
            for (const file of migrationFiles) await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
        } finally {
            await client.end();
        }
    })();
    // Evita "unhandled rejection" se ninguém consultar o banco; o erro reaparece na primeira consulta.
    ready.catch(() => undefined);

    const wrap = (stmt: D1PreparedStatement) => {
        const bound = {
            __inner: stmt,
            bind: (...args: unknown[]) => wrap(stmt.bind(...args)),
            first: async () => (await ready, stmt.first()),
            all: async () => (await ready, stmt.all()),
            run: async () => (await ready, stmt.run()),
        };
        return bound;
    };
    return {
        prepare: (sql: string) => wrap(inner.prepare(sql)),
        async batch(statements: { __inner: D1PreparedStatement }[]) {
            await ready;
            return inner.batch(statements.map((s) => s.__inner));
        },
    } as unknown as D1Database;
}
