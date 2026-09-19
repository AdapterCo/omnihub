// Health check (§56): confirma que o app consegue falar com o banco. Resposta mínima e
// sem detalhes internos — o endpoint é público e usado por Docker/Traefik/monitoramento.
export type HealthResult = { ok: boolean; status: 'ok' | 'error'; checks: { database: 'ok' | 'error' }; uptimeSeconds: number };

export async function checkHealth(db: D1Database, timeoutMs = 3000): Promise<HealthResult> {
    let database: 'ok' | 'error' = 'error';
    try {
        const probe = db.prepare('SELECT 1 AS ok').bind().first<{ ok: number }>();
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref?.());
        const row = await Promise.race([probe, timeout]);
        if (row && Number(row.ok) === 1) database = 'ok';
    } catch {
        database = 'error';
    }
    const ok = database === 'ok';
    return { ok, status: ok ? 'ok' : 'error', checks: { database }, uptimeSeconds: Math.floor(process.uptime()) };
}
