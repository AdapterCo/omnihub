import { runFiscalJobWorker } from './queue.ts';

// Processamento automático da fila fiscal (§41): laço em processo, iniciado uma vez por
// servidor Node em instrumentation.ts. Seguro com várias instâncias: cada job é
// reivindicado atomicamente (UPDATE ... RETURNING em queue.ts). Sem sobreposição de
// execuções na mesma instância. Falhas de um ciclo nunca derrubam o servidor.
// FISCAL_WORKER_INTERVAL_MS: intervalo em ms (padrão 30000; 0 desliga o worker).
const DEFAULT_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startFiscalWorker(db: D1Database, env: Record<string, string | undefined> = process.env): boolean {
    if (timer) return true;
    const raw = env.FISCAL_WORKER_INTERVAL_MS;
    const intervalMs = raw === undefined || raw === '' ? DEFAULT_INTERVAL_MS : Number(raw);
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
        console.error(`FISCAL_WORKER_INTERVAL_MS inválida ("${raw}"): worker fiscal não iniciado.`);
        return false;
    }
    if (intervalMs === 0) return false;

    timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            const result = await runFiscalJobWorker(db);
            if (result.processed > 0) {
                console.log(`[fiscal-worker] ${result.processed} job(s): ${result.succeeded} sucesso, ${result.failed} falha, ${result.deadLettered} dead-letter`);
            }
        } catch (err) {
            console.error('[fiscal-worker] ciclo falhou', err);
        } finally {
            running = false;
        }
    }, intervalMs);
    timer.unref?.();
    return true;
}

export function stopFiscalWorker(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
