import { reconcileOpenSubscriptions, subscriptionDepsFromEnv } from './service.ts';
import { logger } from '../log.ts';

// Consulta periódica das assinaturas da plataforma ao Mercado Pago (não há webhook): primeiro
// pagamento, renovação mensal, criação com resposta incerta e expiração das contas cujo período
// pago terminou. Mesmo padrão dos outros workers: laço em processo, sem sobreposição, falha de um
// ciclo não derruba o servidor.
// SUBSCRIPTION_WORKER_INTERVAL_MS: intervalo em ms (padrão 300000; 0 desliga).
const DEFAULT_INTERVAL_MS = 300_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startSubscriptionWorker(db: D1Database, env: Record<string, string | undefined> = process.env): boolean {
    if (timer) return true;
    const raw = env.SUBSCRIPTION_WORKER_INTERVAL_MS;
    const intervalMs = raw === undefined || raw === '' ? DEFAULT_INTERVAL_MS : Number(raw);
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
        logger.error('subscription-worker.config_invalida', { variavel: 'SUBSCRIPTION_WORKER_INTERVAL_MS', valor: raw });
        return false;
    }
    if (intervalMs === 0) return false;
    const { client } = subscriptionDepsFromEnv(env);
    if (!client) return false; // cobrança da plataforma não configurada
    timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            const result = await reconcileOpenSubscriptions(db, client);
            if (result.checked > 0) logger.info('subscription-worker.ciclo', result);
        } catch (error) {
            logger.error('subscription-worker.ciclo_falhou', { error });
        } finally {
            running = false;
        }
    }, intervalMs);
    timer.unref?.();
    return true;
}

export function stopSubscriptionWorker(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
