import { reconcileBilling } from './service.ts';
import { logger } from '../log.ts';
let timer:ReturnType<typeof setInterval>|undefined;
export function startBillingWorker(db:D1Database) {
 const ms=Number(process.env.BILLING_WORKER_INTERVAL_MS??60000);
 if(timer||ms===0)return false;
 if(!Number.isFinite(ms)||ms<1000){logger.error('billing-worker.intervalo_invalido');return false;}
 let running=false;
 timer=setInterval(async()=>{if(running)return;running=true;try{await reconcileBilling(db);}catch(error){logger.error('billing-worker.erro',{error});}finally{running=false;}},ms);
 timer.unref();return true;
}
