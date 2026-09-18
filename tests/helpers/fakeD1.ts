import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Banco SQLite real (node:sqlite) por trás de um adaptador que expõe o subconjunto da
 * API do D1Database usado pelos módulos de serviço (prepare/bind/all/first/run/batch).
 * Usado apenas em testes: valida as instruções SQL de verdade (incluindo o CHECK de
 * estoque não-negativo e o UPDATE guardado). As migrações em `sqlite-migrations/` são um
 * dublê de teste — a produção agora usa PostgreSQL (`drizzle/*.sql` + `scripts/migrate.mjs`,
 * ver db/database.ts). Manter as duas sincronizadas ao adicionar uma tabela/coluna.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = ['0000_yielding_franklin_richards.sql', '0001_material_sersi.sql', '0002_vengeful_sphinx.sql', '0003_wooden_patch.sql', '0004_backfill_catalog_stock.sql', '0005_wandering_cyclops.sql', '0006_fiscal_foundation.sql', '0007_customers_suppliers.sql', '0008_fiscal_inutilizacao.sql', '0009_nfce_foundation.sql', '0010_audit_full.sql', '0011_fiscal_jobs.sql', '0012_auth_credentials.sql'];

type BoundStatement = {
    all<T>(): Promise<{ results: T[] }>;
    first<T>(): Promise<T | null>;
    run(): Promise<{ meta: { changes: number; last_row_id: number | bigint } }>;
};

function wrapStatement(raw: ReturnType<DatabaseSync['prepare']>, args: unknown[]): BoundStatement {
    return {
        async all<T>() {
            return { results: raw.all(...(args as never[])) as T[] };
        },
        async first<T>() {
            return (raw.get(...(args as never[])) as T | undefined) ?? null;
        },
        async run() {
            const info = raw.run(...(args as never[]));
            return { meta: { changes: Number(info.changes), last_row_id: info.lastInsertRowid } };
        },
    };
}

export function createFakeD1() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON;');
    for (const file of MIGRATIONS) {
        const text = readFileSync(join(HERE, 'sqlite-migrations', file), 'utf8').replace(/--> statement-breakpoint/g, '');
        sqlite.exec(text);
    }
    const db = {
        prepare(sql: string) {
            const raw = sqlite.prepare(sql);
            return { bind: (...args: unknown[]): BoundStatement => wrapStatement(raw, args) };
        },
        async batch(statements: BoundStatement[]) {
            sqlite.exec('BEGIN');
            try {
                const results = [];
                for (const statement of statements) results.push(await statement.run());
                sqlite.exec('COMMIT');
                return results;
            } catch (error) {
                sqlite.exec('ROLLBACK');
                throw error;
            }
        },
    };
    return db as unknown as D1Database;
}
