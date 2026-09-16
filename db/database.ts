import { env } from 'cloudflare:workers';
export function database(): D1Database { if (!env.DB) throw new Error('Banco de dados indisponível.'); return env.DB; }

