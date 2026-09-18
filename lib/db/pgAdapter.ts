import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

// O driver `pg` devolve int8 (bigint, incluindo COUNT(*)) e numeric (SUM de bigint) como
// string por padrão. Todo o código de negócio espera `number` (timestamps em ms e valores
// em centavos ficam bem abaixo de 2^53), então converte na leitura.
pg.types.setTypeParser(20, (value) => Number(value));
pg.types.setTypeParser(1700, (value) => Number(value));

// Adaptador que expõe uma interface compatível com o antigo binding D1 do Cloudflare
// (prepare/bind/first/all/run/batch — ver types/database.d.ts) sobre um Pool do
// PostgreSQL (`pg`). Objetivo: nenhum dos módulos em lib/*/service.ts precisa mudar —
// todos já recebem `db: D1Database` como parâmetro e usam exatamente essas chamadas.
//
// Traduções de dialeto feitas aqui (não no código de negócio):
// - `?` posicional (SQLite/D1) -> `$1, $2, ...` (Postgres).
// - `RETURNING`, `ON CONFLICT ... DO UPDATE ... WHERE ...`: sintaxe já compatível entre os
//   dois bancos, nenhuma tradução necessária.
// - `.batch([...])`: executado como uma transação real do Postgres (BEGIN/COMMIT/ROLLBACK).
//
// LIMITAÇÃO EXPLÍCITA, NÃO ESCONDIDA: este adaptador segue a sintaxe padrão documentada do
// PostgreSQL, mas não foi executado contra um servidor Postgres real nesta sessão (este
// sandbox não tem PostgreSQL/Docker disponível — mesma classe de limitação já registrada
// para a SEFAZ ao longo do projeto). A suíte de testes automatizados continua rodando
// contra o dublê SQLite (`tests/helpers/fakeD1.ts`) para validar a lógica de negócio; a
// tradução de dialeto em si deve ser confirmada na primeira execução real na VPS.

function toPositionalSql(sql: string): string {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
}

type Executor = { query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> };

class PgPreparedStatement implements D1PreparedStatement {
    constructor(
        private readonly executor: Executor,
        private readonly sql: string,
        private readonly args: unknown[] = [],
    ) {}

    bind(...values: unknown[]): D1PreparedStatement {
        return new PgPreparedStatement(this.executor, this.sql, values);
    }

    async first<T = unknown>(): Promise<T | null> {
        const result = await this.executor.query(toPositionalSql(this.sql), this.args);
        return (result.rows[0] as T) ?? null;
    }

    async all<T = unknown>(): Promise<D1Result<T>> {
        const result = await this.executor.query(toPositionalSql(this.sql), this.args);
        return { results: result.rows as T[] };
    }

    async run(): Promise<D1RunResult> {
        const result = await this.executor.query(toPositionalSql(this.sql), this.args);
        return { meta: { changes: result.rowCount ?? 0, last_row_id: 0 } };
    }

    // Uso interno de batch(): acesso direto ao SQL/args já vinculados, sem expor isso na
    // interface pública D1PreparedStatement.
    _sql(): string {
        return this.sql;
    }
    _args(): unknown[] {
        return this.args;
    }
}

export function createPostgresD1Adapter(pool: Pool): D1Database {
    return {
        prepare(query: string): D1PreparedStatement {
            return new PgPreparedStatement(pool, query);
        },
        async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1RunResult[]> {
            const client: PoolClient = await pool.connect();
            try {
                await client.query('BEGIN');
                const results: D1RunResult[] = [];
                for (const stmt of statements) {
                    const s = stmt as PgPreparedStatement;
                    const result = await client.query(toPositionalSql(s._sql()), s._args());
                    results.push({ meta: { changes: result.rowCount ?? 0, last_row_id: 0 } });
                }
                await client.query('COMMIT');
                return results as unknown as D1RunResult[];
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        },
    };
}
