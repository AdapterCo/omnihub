// Executado uma vez quando o servidor Next.js (Node) inicia. Liga o worker automático da
// fila fiscal (§41). Fora do runtime Node (ex.: edge) não faz nada.
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;
    if (!process.env.DATABASE_URL) return;
    const { database } = await import('./db/database');
    const { startFiscalWorker } = await import('./lib/fiscal/worker');
    const { logger } = await import('./lib/log');
    if (startFiscalWorker(database())) logger.info('fiscal-worker.iniciado');
    // Reconciliação de cobranças integradas (Mercado Pago) abertas.
    const { startPaymentWorker } = await import('./lib/payments/worker');
    if (startPaymentWorker(database())) logger.info('payment-worker.iniciado');
}
