// Declaração ambiente própria do tipo `D1Database`, substituindo o pacote
// `@cloudflare/workers-types` (removido junto com o resto da integração Cloudflare/ChatGPT
// Sites). Mantém o mesmo nome/formato usado em todo `lib/*/service.ts` (prepare/bind/
// first/all/run/batch) para que nenhum desses módulos precise mudar de assinatura ao
// trocar o binding D1 pelo adaptador PostgreSQL em `lib/db/pgAdapter.ts`.
export {};

declare global {
    interface D1Result<T = unknown> {
        results: T[];
    }

    interface D1RunResult {
        meta: { changes: number; last_row_id: number | bigint };
    }

    interface D1PreparedStatement {
        bind(...values: unknown[]): D1PreparedStatement;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        first<T = Record<string, any>>(): Promise<T | null>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        all<T = Record<string, any>>(): Promise<D1Result<T>>;
        run(): Promise<D1RunResult>;
    }

    interface D1Database {
        prepare(query: string): D1PreparedStatement;
        batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1RunResult[]>;
    }
}
