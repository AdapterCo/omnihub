import { reconcileSignatures, type SignatureDeps } from './service.ts';
import type { SignFetch } from './adapterSign.ts';
import { storageFromEnv } from '../storage/index.ts';
import { logger } from '../log.ts';

// Reconciliação automática das assinaturas (eventos de webhook pendentes, envios com resultado
// incerto e contratos sem notícia há mais de 10 min). Mesmo padrão dos workers fiscal e de
// pagamentos: laço em processo, sem sobreposição, falha de um ciclo nunca derruba o servidor.
// SIGNATURE_WORKER_INTERVAL_MS: intervalo em ms (padrão 60000; 0 desliga). Sem STORAGE_DIR não
// liga (não haveria onde gravar o contrato assinado).
const DEFAULT_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function signatureDepsFromEnv(): SignatureDeps {
 return { fetch: globalThis.fetch as unknown as SignFetch, storage: storageFromEnv() };
}

export function startSignatureWorker(db: D1Database, env: Record<string, string | undefined> = process.env): boolean {
 if (timer) return true;
 const raw = env.SIGNATURE_WORKER_INTERVAL_MS;
 const intervalMs = raw === undefined || raw === '' ? DEFAULT_INTERVAL_MS : Number(raw);
 if (!Number.isFinite(intervalMs) || intervalMs < 0) {
  logger.error('signature-worker.config_invalida', { variavel: 'SIGNATURE_WORKER_INTERVAL_MS', valor: raw });
  return false;
 }
 if (intervalMs === 0) return false;
 if (!(env.STORAGE_DIR ?? '').trim()) {
  logger.error('signature-worker.sem_storage', { motivo: 'STORAGE_DIR não definido; contratos assinados não teriam onde ser gravados.' });
  return false;
 }
 timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
   const result = await reconcileSignatures(db, signatureDepsFromEnv());
   if (result.events + result.resent + result.synced > 0) logger.info('signature-worker.ciclo', result);
  } catch (error) {
   logger.error('signature-worker.ciclo_falhou', { error });
  } finally {
   running = false;
  }
 }, intervalMs);
 timer.unref?.();
 return true;
}
