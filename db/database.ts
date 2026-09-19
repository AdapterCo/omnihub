import { Pool } from 'pg';
import { createPostgresD1Adapter } from '@/lib/db/pgAdapter';
import { logger } from '@/lib/log';

// Substitui o binding D1 do Cloudflare (`env.DB`, ChatGPT Sites/Wrangler) por um Pool do
// PostgreSQL, único ponto de conexão do projeto. `DATABASE_URL` é obrigatória — nunca
// presumida com um valor padrão (§ regra inegociável de CLAUDE.md aplicada também a
// configuração de infraestrutura, não só a dados fiscais).
let pool: Pool | null = null;
let adapter: D1Database | null = null;

export function database(): D1Database {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error(
            'DATABASE_URL não configurada. Defina a string de conexão do PostgreSQL (ex.: postgres://usuario:senha@host:5432/omnihub) nas variáveis de ambiente antes de iniciar o servidor.',
        );
    }
    if (!pool) {
        pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_MAX) || 10 });
        // Sem este handler, um restart/queda do PostgreSQL emite 'error' num cliente ocioso e
        // derruba o processo Node inteiro (exceção não tratada).
        pool.on('error', (error) => logger.error('db.pool_erro_conexao_ociosa', { error }));
    }
    if (!adapter) {
        adapter = createPostgresD1Adapter(pool);
    }
    return adapter;
}
