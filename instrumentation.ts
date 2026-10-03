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
    // Reconciliação das assinaturas do Adapter Sign (webhook perdido, envio com resultado incerto).
    const { startSignatureWorker } = await import('./lib/signature/worker');
    if (startSignatureWorker(database())) logger.info('signature-worker.iniciado');
    const { startBillingWorker } = await import('./lib/billing/worker');
    if (startBillingWorker(database())) logger.info('billing-worker.iniciado');
    // Assinaturas da plataforma (planos pagos pelo Mercado Pago): renovação e expiração.
    const { startSubscriptionWorker } = await import('./lib/subscriptions/worker');
    if (startSubscriptionWorker(database())) logger.info('subscription-worker.iniciado');
    // Limpeza de eventos de webhook resolvidos (90 dias) e credenciais temporárias vencidas.
    const { startMaintenanceWorker } = await import('./lib/maintenance');
    if (startMaintenanceWorker(database())) logger.info('maintenance-worker.iniciado');
}
