// Executado uma vez quando o servidor Next.js (Node) inicia. Liga o worker automático da
// fila fiscal (§41). Fora do runtime Node (ex.: edge) não faz nada.
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;
    if (!process.env.DATABASE_URL) return;
    const { database } = await import('./db/database');
    const { startFiscalWorker } = await import('./lib/fiscal/worker');
    if (startFiscalWorker(database())) console.log('[fiscal-worker] iniciado');
}
