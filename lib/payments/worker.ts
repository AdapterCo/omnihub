import { reconcileOpenCharges } from './service.ts';
import { logger } from '../log.ts';

// Reconciliação automática de cobranças integradas abertas (tela do caixa fechada, webhook
// perdido, criação com falha de rede). Mesmo padrão do worker fiscal: laço em processo,
// sem sobreposição, falha de um ciclo nunca derruba o servidor.
// PAYMENT_WORKER_INTERVAL_MS: intervalo em ms (padrão 20000; 0 desliga).
const DEFAULT_INTERVAL_MS = 20_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startPaymentWorker(db: D1Database, env: Record<string, string | undefined> = process.env): boolean {
    if (timer) return true;
    const raw = env.PAYMENT_WORKER_INTERVAL_MS;
    const intervalMs = raw === undefined || raw === '' ? DEFAULT_INTERVAL_MS : Number(raw);
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
        logger.error('payment-worker.config_invalida', { variavel: 'PAYMENT_WORKER_INTERVAL_MS', valor: raw });
        return false;
    }
    if (intervalMs === 0) return false;
    timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            const result = await reconcileOpenCharges(db);
            if (result.checked > 0) logger.info('payment-worker.ciclo', result);
        } catch (error) {
            logger.error('payment-worker.ciclo_falhou', { error });
        } finally {
            running = false;
        }
    }, intervalMs);
    timer.unref?.();
    return true;
}

export function stopPaymentWorker(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
