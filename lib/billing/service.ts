import { randomBytes, timingSafeEqual } from 'node:crypto';
import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import { encryptPayload, decryptPayload } from '../fiscal/certificate.ts';
import { recordAudit } from '../audit/service.ts';
import { dayKey } from '../time.ts';
import { AsaasClient, AsaasError, type AsaasPayment, type BillingFetch } from './asaas.ts';

type Config = {store_id: string; tenant_id: string; environment: string; api_key_enc: string; webhook_secret_enc: string; webhook_key: string; notifications_enabled: number};
type Order = {id: string; store_id: string; customer_id: string; type: string; status: string; total: number; down_payment: number; installments: number; first_due_date: string; monthly_amount: number; adhesion_amount: number; adhesion_billing: string; due_day: number; unit_id: string; product_id: string};
export type Receivable = {id: string; tenant_id: string; store_id: string; order_id: string; customer_id: string; kind: string; sequence: number; amount: number; due_date: string; fine_bp: number; interest_bp: number; environment: string; status: string; provider_status: string; external_ref: string; provider_id: string | null; provider_customer_id: string | null; invoice_url: string; last_error: string; checked_at: number | null; created_at: number; updated_at: number};
const enc = (s: string) => JSON.stringify(encryptPayload(s));
function dec(s: string): string { try { return decryptPayload(JSON.parse(s)).toString('utf8'); } catch { throw new RuleError('Credenciais Asaas ilegíveis. Confira a chave de criptografia do servidor.',409); } }
// Status oficiais de pagamento recebido (GET /payments/{id}, enum status): boleto compensado,
// confirmado, baixa manual "recebido em dinheiro" e recebido via negativação feita no próprio Asaas.
const paid = (s: string) => ['RECEIVED','CONFIRMED','RECEIVED_IN_CASH','DUNNING_RECEIVED'].includes(s);
async function config(db: D1Database, tenant: string, store: string) {
 const c = await db.prepare('SELECT * FROM order_billing_configs WHERE tenant_id = ? AND store_id = ?').bind(tenant,store).first<Config>();
 if (!c) throw new RuleError('Configure a cobrança Asaas desta loja.',409); return c;
}
async function orderScope(db: D1Database, tenant: string, id: string, actor: Actor, permission: 'ORDER_VIEW'|'ORDER_CREATE'|'ORDER_CANCEL'|'ORDER_COMPLETE' = 'ORDER_VIEW') {
 requirePermission(actor.permissions,permission);
 const o = await db.prepare('SELECT * FROM orders WHERE id = ? AND tenant_id = ?').bind(id,tenant).first<Order>();
 if (!o) throw new RuleError('Pedido não encontrado.',404); requireStoreAccess(actor,o.store_id); return o;
}
function audit(db: D1Database, tenant: string, o: Order, actor: Actor, action: string, description: string, now: number) {
 return recordAudit(db,{tenantId:tenant,storeId:o.store_id,userId:actor.userId,operator:actor.displayName,action,description,entity:'order',entityId:o.id},now);
}
export async function saveBillingConfig(db: D1Database, tenant: string, store: string, input: {environment: string; apiKey?: string; webhookSecret?: string; notificationsEnabled: boolean}, actor: Actor, now=Date.now()) {
 requirePermission(actor.permissions,'PAYMENT_CONFIG'); requireStoreAccess(actor,store);
 if (!await db.prepare('SELECT id FROM stores WHERE id = ? AND tenant_id = ?').bind(store,tenant).first()) throw new RuleError('Loja não encontrada.',404);
 if (!['SANDBOX','PRODUCTION'].includes(input.environment) || typeof input.notificationsEnabled !== 'boolean') throw new RuleError('Escolha o ambiente e se os avisos configurados no Asaas devem ser enviados.',400);
 const old=await db.prepare('SELECT * FROM order_billing_configs WHERE store_id = ? AND tenant_id = ?').bind(store,tenant).first<Config>();
 if (old && old.environment !== input.environment && await db.prepare('SELECT id FROM order_receivables WHERE store_id = ? LIMIT 1').bind(store).first()) throw new RuleError('Esta loja já tem cobranças neste ambiente. Não é permitido trocar o ambiente e perder sua conciliação.',409);
 const key=input.apiKey?.trim(), secret=input.webhookSecret?.trim();
 if ((!old && !key) || (key && (key.length<10 || key.length>500 || /\s/.test(key)))) throw new RuleError('Informe uma API key válida.',400);
 if ((!old && !secret) || (secret && (secret.length<32 || secret.length>255 || /\s/.test(secret) || secret===key))) throw new RuleError('Informe um token de webhook próprio, de 32 a 255 caracteres, sem espaços.',400);
 await db.prepare(`INSERT INTO order_billing_configs (store_id,tenant_id,environment,api_key_enc,webhook_secret_enc,webhook_key,notifications_enabled,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(store_id) DO UPDATE SET environment=excluded.environment,api_key_enc=excluded.api_key_enc,webhook_secret_enc=excluded.webhook_secret_enc,notifications_enabled=excluded.notifications_enabled,updated_at=excluded.updated_at`).bind(store,tenant,input.environment,key?enc(key):old!.api_key_enc,secret?enc(secret):old!.webhook_secret_enc,old?.webhook_key??randomBytes(24).toString('hex'),input.notificationsEnabled?1:0,now).run();
 await recordAudit(db,{tenantId:tenant,storeId:store,userId:actor.userId,operator:actor.displayName,action:'billing.config',description:'Configuração Asaas atualizada',entity:'store',entityId:store},now);
}
export async function billingView(db: D1Database, tenant: string, id: string, actor: Actor) {
 const o=await orderScope(db,tenant,id,actor);
 const c=await db.prepare('SELECT environment, webhook_key AS webhookKey, notifications_enabled AS notificationsEnabled FROM order_billing_configs WHERE tenant_id = ? AND store_id = ?').bind(tenant,o.store_id).first<{environment:string;webhookKey:string;notificationsEnabled:number}>();
 const rows=await db.prepare('SELECT * FROM order_receivables WHERE tenant_id = ? AND order_id = ? ORDER BY due_date,kind,sequence').bind(tenant,id).all<Receivable>();
 const closure=await db.prepare('SELECT type,status,effective_date AS effectiveDate,assessment,damage_amount AS damageAmount FROM rental_closures WHERE order_id = ? AND tenant_id = ?').bind(id,tenant).first();
 return {config:c?{environment:c.environment,notificationsEnabled:!!c.notificationsEnabled,webhookPath:actor.permissions.has('PAYMENT_CONFIG')?`/api/billing/asaas/webhook/${c.webhookKey}`:null}:null,receivables:(rows.results??[]).map(r=>({id:r.id,kind:r.kind,sequence:Number(r.sequence),amount:Number(r.amount),dueDate:r.due_date,status:r.status,providerStatus:r.provider_status,url:r.invoice_url,error:r.last_error,environment:r.environment})),closure};
}
export function validBillingDate(s: string) { const d=new Date(s+'T12:00:00Z'); return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number(s.slice(0,4))>=2000 && Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===s; }
// Proposta técnica explícita na prévia: dia original, limitado ao último dia de cada mês.
export function monthlyDates(first: string,count: number): string[] {
 if (!validBillingDate(first)) throw new RuleError('Data de vencimento inválida.',400);
 const [y,m,d]=first.split('-').map(Number);
 return Array.from({length:count},(_,i)=> {const last=new Date(Date.UTC(y,m+i,0)).getUTCDate();return new Date(Date.UTC(y,m-1+i,Math.min(d,last))).toISOString().slice(0,10);});
}
export type ScheduleInput = {firstDueDate?: string; adhesionDueDate?: string; fineBp?: number; interestBp?: number};
export async function prepareSchedule(db: D1Database, tenant: string, id: string, input: ScheduleInput, actor: Actor, now=Date.now()) {
 const o=await orderScope(db,tenant,id,actor,'ORDER_CREATE');
 // Só cobrar condições já finalizadas: evita edição/cancelamento concorrente do pedido aberto.
 if (o.status!=='COMPLETED') throw new RuleError('Finalize o pedido na loja antes de preparar as cobranças.',409);
 const c=await config(db,tenant,o.store_id);
 if (await db.prepare('SELECT order_id FROM rental_closures WHERE order_id = ?').bind(id).first()) throw new RuleError('Locação em encerramento.',409);
 if (await db.prepare("SELECT id FROM order_receivables WHERE order_id = ? AND kind IN ('INSTALLMENT','RENT','ADHESION') LIMIT 1").bind(id).first()) return;
 const count=o.type==='LOCACAO'?12:Number(o.installments);
 if (!count) throw new RuleError('Este pedido não tem parcelas no boleto.',409);
 const first=o.type==='LOCACAO'?String(input.firstDueDate??''):o.first_due_date;
 if (!validBillingDate(first) || first<dayKey(now)) throw new RuleError('Informe o primeiro vencimento, sem data passada.',400);
 if (o.type==='LOCACAO' && Number(first.slice(-2))!==Number(o.due_day)) throw new RuleError('O primeiro vencimento deve respeitar o dia do contrato.',400);
 const fine=o.type==='LOCACAO'?200:input.fineBp, interest=o.type==='LOCACAO'?100:input.interestBp;
 if (![fine,interest].every(v=>Number.isInteger(v)&&v!>=0&&v!<=10000)) throw new RuleError('Informe multa e juros da venda, inclusive zero se não houver.',400);
 const total=o.type==='LOCACAO'?Number(o.monthly_amount)*12:Number(o.total)-Number(o.down_payment);
 const unit=Math.floor(total/count);
 if (unit<1) throw new RuleError('Valor de parcela inválido.',400);
 const entries=monthlyDates(first,count).map((due,i)=>({kind:o.type==='LOCACAO'?'RENT':'INSTALLMENT',sequence:i+1,amount:i===count-1?total-unit*(count-1):unit,due}));
 if(o.type==='LOCACAO' && o.adhesion_billing==='BOLETO') {
  const due=String(input.adhesionDueDate??''); if(!validBillingDate(due)||due<dayKey(now)) throw new RuleError('Informe o vencimento do boleto de adesão.',400);
  entries.unshift({kind:'ADHESION',sequence:1,amount:Number(o.adhesion_amount),due});
 }
 await db.batch(entries.map(e=>db.prepare(`INSERT INTO order_receivables (id,tenant_id,store_id,order_id,customer_id,kind,sequence,amount,due_date,fine_bp,interest_bp,environment,status,external_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?) ON CONFLICT(order_id,kind,sequence) DO NOTHING`).bind(crypto.randomUUID(),tenant,o.store_id,id,o.customer_id,e.kind,e.sequence,e.amount,e.due,fine,interest,c.environment,`omnihub-${id}-${e.kind}-${e.sequence}`,now,now)));
 await audit(db,tenant,o,actor,'billing.prepare','Cronograma de boletos preparado para revisão',now);
}
async function loadReceivable(db:D1Database,tenant:string,id:string) {const r=await db.prepare('SELECT * FROM order_receivables WHERE id = ? AND tenant_id = ?').bind(id,tenant).first<Receivable>();if(!r)throw new RuleError('Cobrança não encontrada.',404);return r;}
function client(c:Config,fetcher?:BillingFetch){return new AsaasClient(dec(c.api_key_enc),c.environment,fetcher);}
async function applyPayment(db:D1Database,r:Receivable,p:AsaasPayment,now:number) {
 const amount=Math.round(Number(p.originalValue??p.value)*100);
 if(!p.id || p.externalReference!==r.external_ref || amount!==Number(r.amount) || p.dueDate!==r.due_date || (r.provider_customer_id && p.customer!==r.provider_customer_id) || (r.provider_id && p.id!==r.provider_id)) throw new RuleError('Cobrança Asaas diverge do pedido (referência, cliente, valor ou vencimento). Conciliação bloqueada.',409);
 let url='';try {const u=new URL(p.bankSlipUrl||p.invoiceUrl||'');if(u.protocol==='https:' && (u.hostname==='asaas.com'||u.hostname.endsWith('.asaas.com')))url=u.toString();}catch{}
 const status=p.deleted?'CANCELLED':paid(p.status)?'PAID':p.status==='OVERDUE'?'OVERDUE':['PENDING','AWAITING_RISK_ANALYSIS'].includes(p.status)?'OPEN':p.status==='REFUNDED'?'REFUNDED':'REVIEW';
 await db.prepare('UPDATE order_receivables SET provider_id=?,provider_customer_id=?,provider_status=?,status=?,invoice_url=?,last_error=?,checked_at=?,updated_at=? WHERE id=?').bind(p.id,p.customer,p.status,status,url,'',now,now,r.id).run();
}
export async function syncReceivable(db:D1Database,tenant:string,id:string,fetcher?:BillingFetch,now=Date.now()) {
 const r=await loadReceivable(db,tenant,id), c=await config(db,tenant,r.store_id); if(c.environment!==r.environment)throw new RuleError('Ambiente da cobrança divergente.',409);
 const api=client(c,fetcher);
 if(r.provider_id) {await applyPayment(db,r,await api.getPayment(r.provider_id),now);return;}
 const result=await api.findPayment(r.external_ref);
 if(!Array.isArray(result.data)||result.hasMore||result.data.length>1)throw new RuleError('Mais de uma cobrança ou resposta inválida para a referência. Confira no Asaas.',409);
 if(result.data.length===1)await applyPayment(db,r,result.data[0],now);
 else await db.prepare('UPDATE order_receivables SET checked_at=?,last_error=? WHERE id=?').bind(now,'Nenhuma cobrança localizada. Se o envio foi incerto, confira no Asaas; não haverá reenvio automático.',id).run();
}
export async function issueReceivable(db:D1Database,tenant:string,id:string,actor:Actor,fetcher?:BillingFetch,now=Date.now()) {
 const r=await loadReceivable(db,tenant,id), o=await orderScope(db,tenant,r.order_id,actor,'ORDER_CREATE');
 if(o.status!=='COMPLETED')throw new RuleError('Pedido não está finalizado.',409);
 const closure=await db.prepare('SELECT type FROM rental_closures WHERE order_id = ?').bind(o.id).first<{type:string}>();
 if(closure && r.kind!=='DAMAGE' && r.kind!=='RESIDUAL')throw new RuleError('Locação em encerramento: não emitir novas mensalidades.',409);
 if(r.status!=='DRAFT'){await syncReceivable(db,tenant,id,fetcher,now);return;}
 const c=await config(db,tenant,r.store_id),api=client(c,fetcher);
 if(c.environment!==r.environment)throw new RuleError('Ambiente da cobrança divergente.',409);
 const customer=await db.prepare('SELECT name,document,email,phone FROM customers WHERE id=? AND tenant_id=?').bind(r.customer_id,tenant).first<{name:string;document:string;email:string;phone:string}>();
 if(!customer||!/^\d{11}(\d{3})?$/.test(customer.document.replace(/\D/g,'')))throw new RuleError('Cliente sem CPF/CNPJ para cobrança.',400);
 const claim=await db.prepare("UPDATE order_receivables SET status='CREATING',updated_at=? WHERE id=? AND status='DRAFT' AND (kind IN ('DAMAGE','RESIDUAL') OR NOT EXISTS(SELECT 1 FROM rental_closures WHERE order_id=order_receivables.order_id))").bind(now,id).run();
 if(claim.meta.changes!==1)throw new RuleError('Cobrança já está sendo enviada.',409);
 let paymentStarted=false;
 try {
  const existing=await api.findPayment(r.external_ref);
  if(existing.data.length){if(existing.data.length!==1||existing.hasMore)throw new RuleError('Referência duplicada no Asaas.',409);await applyPayment(db,r,existing.data[0],now);return;}
  const ref=`omnihub-${tenant}-${r.store_id}-${r.customer_id}`;
  const customers=await api.call<{data:{id:string;cpfCnpj:string}[];hasMore:boolean}>('GET','/customers?limit=100&externalReference='+encodeURIComponent(ref));
  if(!Array.isArray(customers.data)||customers.data.length>1||customers.hasMore)throw new RuleError('Cadastro duplicado no Asaas; confira o cliente.',409);
  let cust=customers.data[0];
  if(!cust)cust=await api.call('POST','/customers',{name:customer.name,cpfCnpj:customer.document,email:customer.email||undefined,mobilePhone:customer.phone.replace(/\D/g,'')||undefined,externalReference:ref,notificationDisabled:!c.notifications_enabled});
  if(!cust?.id || cust.cpfCnpj.replace(/\D/g,'')!==customer.document.replace(/\D/g,''))throw new RuleError('Cliente retornado pelo Asaas diverge do cadastro.',409);
  await db.prepare('UPDATE order_receivables SET provider_customer_id=? WHERE id=?').bind(cust.id,id).run();r.provider_customer_id=cust.id;
  paymentStarted=true;
  const p=await api.createPayment({customer:cust.id,billingType:'BOLETO',value:Number(r.amount)/100,dueDate:r.due_date,externalReference:r.external_ref,description:`Pedido ${o.id} - ${r.kind} ${r.sequence}`,fine:{value:Number(r.fine_bp)/100,type:'PERCENTAGE'},interest:{value:Number(r.interest_bp)/100}});
  await applyPayment(db,r,p,now);
  await audit(db,tenant,o,actor,'billing.issue','Boleto emitido e vinculado ao pedido',now);
 }catch(error){
  const uncertain=paymentStarted || (error instanceof AsaasError && error.uncertain);
  await db.prepare("UPDATE order_receivables SET status=?,last_error=?,updated_at=? WHERE id=? AND status='CREATING'").bind(uncertain?'UNCERTAIN':'DRAFT',error instanceof RuleError?error.message:'Falha ao emitir boleto; consulte o provedor.',now,id).run();throw error;
 }
}
export async function receiveAsaasEvent(db:D1Database,key:string,token:string,body:unknown,now=Date.now()) {
 const c=await db.prepare('SELECT * FROM order_billing_configs WHERE webhook_key=?').bind(key).first<Config>();if(!c)return 404;
 const secret=dec(c.webhook_secret_enc);const a=Buffer.from(token),b=Buffer.from(secret);if(a.length!==b.length||!timingSafeEqual(a,b))return 401;
 const p=body as {id?:string;payment?:{id?:string}};
 if(!p?.id||typeof p.id!=='string'||p.id.length>200)return 400;
 // Eventos que não são de cobrança (conta, transferência etc.) são aceitos e ignorados: responder
 // erro faria o Asaas penalizar a fila de webhooks da conta inteira.
 if(p.payment===undefined||p.payment===null)return 200;
 if(typeof p.payment.id!=='string'||p.payment.id.length>100)return 400;
 await db.prepare('INSERT INTO asaas_events(id,store_id,event_id,payment_id,received_at) VALUES(?,?,?,?,?) ON CONFLICT(store_id,event_id) DO NOTHING').bind(crypto.randomUUID(),c.store_id,p.id,p.payment.id,now).run();return 200;
}
export async function reconcileBilling(db:D1Database,fetcher?:BillingFetch,now=Date.now()) {
 const events=await db.prepare("SELECT e.id,r.id AS receivableId,r.tenant_id AS tenantId FROM asaas_events e JOIN order_receivables r ON r.store_id=e.store_id AND r.provider_id=e.payment_id WHERE e.status='RECEIVED' AND e.attempts<10 ORDER BY e.received_at LIMIT 50").bind().all<{id:string;receivableId:string;tenantId:string}>();
 for(const e of events.results??[])try{await syncReceivable(db,e.tenantId,e.receivableId,fetcher,now);await db.prepare("UPDATE asaas_events SET status='PROCESSED' WHERE id=?").bind(e.id).run();}catch{await db.prepare('UPDATE asaas_events SET attempts=attempts+1 WHERE id=?').bind(e.id).run();}
 const pending=await db.prepare("SELECT id,tenant_id AS tenantId FROM order_receivables WHERE status IN ('OPEN','OVERDUE','UNCERTAIN','CREATING') AND (checked_at IS NULL OR checked_at<?) AND updated_at<? ORDER BY checked_at LIMIT 30").bind(now-30*60_000,now-60_000).all<{id:string;tenantId:string}>();
 for(const r of pending.results??[])try{await syncReceivable(db,r.tenantId,r.id,fetcher,now);}catch{await db.prepare('UPDATE order_receivables SET checked_at=? WHERE id=?').bind(now,r.id).run();}
}

/** Regras do contrato de locação v1, cláusulas 4, 7 e 9. Sem negativação/bloqueio remoto. */
export async function closeRental(db:D1Database,tenant:string,id:string,input:{type:'RETURN'|'PURCHASE';assessment:string;damageAmount:number;damageDueDate?:string;residualDueDate?:string},actor:Actor,fetcher?:BillingFetch,now=Date.now()) {
 const o=await orderScope(db,tenant,id,actor,'ORDER_COMPLETE');
 if(o.type!=='LOCACAO'||o.status!=='COMPLETED')throw new RuleError('A locação precisa estar entregue para encerrar.',409);
 if(!['RETURN','PURCHASE'].includes(input.type))throw new RuleError('Tipo de encerramento inválido.',400);
 const old=await db.prepare('SELECT * FROM rental_closures WHERE order_id=? AND tenant_id=?').bind(id,tenant).first<{type:string;status:string;effective_date:string;assessment:string;damage_amount:number}>();
 if(old?.status==='COMPLETED')return;
 if(old && old.type!==input.type)throw new RuleError('Já existe outro encerramento em andamento.',409);
 const assessment=old?.assessment??String(input.assessment??'').trim();
 const damage=old?Number(old.damage_amount):input.damageAmount;
 if(assessment.length<5||assessment.length>2000||!Number.isSafeInteger(damage)||damage<0||damage>100000000)throw new RuleError('Informe a avaliação presencial e o valor exato das avarias (zero se não houver).',400);
 if(input.type==='PURCHASE' && damage!==0)throw new RuleError('Cobrança de avarias pertence à devolução.',400);
 const c=await config(db,tenant,o.store_id),api=client(c,fetcher);
 const contract=await db.prepare("SELECT template_key AS templateKey,template_version AS version FROM contracts WHERE order_id=? AND tenant_id=? AND internal_status='COMPLETED' ORDER BY revision DESC LIMIT 1").bind(id,tenant).first<{templateKey:string;version:number}>();
 if(!contract||contract.templateKey!=='contrato-locacao'||Number(contract.version)!==1)throw new RuleError('É necessário contrato de locação v1 assinado para aplicar estas regras.',409);
 const all=await db.prepare('SELECT * FROM order_receivables WHERE order_id=? AND tenant_id=?').bind(id,tenant).all<Receivable>();
 if((all.results??[]).filter(r=>r.kind==='RENT').length!==12)throw new RuleError('Prepare as 12 mensalidades antes de encerrar a locação.',409);
 const effective=old?.effective_date??dayKey(now);
 const extraKind=input.type==='RETURN'?'DAMAGE':'RESIDUAL';
 const extraAmount=input.type==='RETURN'?damage:1990; // contrato v1 cláusula 4.2
 if(extraAmount && !(all.results??[]).some(r=>r.kind===extraKind)) {
  const due=String(input.type==='RETURN'?input.damageDueDate??'':input.residualDueDate??'');
  if(!validBillingDate(due)||due<dayKey(now))throw new RuleError('Informe o vencimento da cobrança de '+(input.type==='RETURN'?'avarias.':'compra (R$ 19,90).'),400);
  if(input.type==='PURCHASE') {
   for(const r of all.results??[]) {if(r.provider_id)await syncReceivable(db,tenant,r.id,fetcher,now);}
   const unpaid=await db.prepare("SELECT id FROM order_receivables WHERE order_id=? AND kind IN ('RENT','ADHESION') AND (status<>'PAID' OR environment<>'PRODUCTION') LIMIT 1").bind(id).first();
   if(unpaid)throw new RuleError('Compra exige adesão e 12 mensalidades confirmadas como pagas em produção.',409);
  }
  await db.prepare(`INSERT INTO order_receivables(id,tenant_id,store_id,order_id,customer_id,kind,sequence,amount,due_date,fine_bp,interest_bp,environment,status,external_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,0,0,?,'DRAFT',?,?,?) ON CONFLICT(order_id,kind,sequence) DO NOTHING`).bind(crypto.randomUUID(),tenant,o.store_id,id,o.customer_id,extraKind,extraAmount,due,c.environment,`omnihub-${id}-${extraKind}-1`,now,now).run();
 }
 await db.prepare("INSERT INTO rental_closures(order_id,tenant_id,type,status,effective_date,assessment,damage_amount,user_id,created_at) VALUES(?,?,?,'PENDING',?,?,?,?,?) ON CONFLICT(order_id) DO NOTHING").bind(id,tenant,input.type,effective,assessment,damage,actor.userId,now).run();
 const token=crypto.randomUUID();
 const claim=await db.prepare("UPDATE rental_closures SET processing_token=?,processing_until=? WHERE order_id=? AND status='PENDING' AND (processing_until IS NULL OR processing_until<?)").bind(token,now+15*60_000,id,now).run();
 if(claim.meta.changes!==1)throw new RuleError('Encerramento em processamento. Aguarde antes de tentar novamente.',409);
 try {
  const rows=await db.prepare('SELECT * FROM order_receivables WHERE order_id=? AND tenant_id=?').bind(id,tenant).all<Receivable>();
  for(const r of rows.results??[]) {
   if(input.type==='PURCHASE') {
    if(r.provider_id)await syncReceivable(db,tenant,r.id,fetcher,now);
    continue;
   }
   if(r.kind!=='RENT'||r.due_date<=effective||r.status==='CANCELLED')continue;
   if(r.status==='DRAFT'){const changed=await db.prepare("UPDATE order_receivables SET status='CANCELLED',updated_at=? WHERE id=? AND status='DRAFT'").bind(now,r.id).run();if(changed.meta.changes!==1)throw new RuleError('Uma mensalidade mudou durante o encerramento. Consulte e retome.',409);continue;}
   await syncReceivable(db,tenant,r.id,fetcher,now);
   const fresh=await loadReceivable(db,tenant,r.id);
   if(fresh.status==='PAID')continue; // valores já pagos não são estornados por suposição
   if(!fresh.provider_id||!['OPEN','OVERDUE','CANCELLED'].includes(fresh.status))throw new RuleError('Há mensalidade com situação incerta. Concilie antes de encerrar.',409);
   if(fresh.status!=='CANCELLED') {
    await api.cancelPayment(fresh.provider_id);
    await db.prepare("UPDATE order_receivables SET status='CANCELLED',provider_status='DELETED',updated_at=? WHERE id=?").bind(now,r.id).run();
   }
  }
  if(input.type==='PURCHASE') {
   const unpaid=await db.prepare("SELECT id FROM order_receivables WHERE order_id=? AND (status<>'PAID' OR environment<>'PRODUCTION') LIMIT 1").bind(id).first();
   if(unpaid)throw new RuleError('Emita e receba o boleto residual. A propriedade só é transferida após quitação confirmada em produção.',409);
  }
  const unit=await db.prepare("SELECT id FROM product_units WHERE id=? AND tenant_id=? AND order_id=? AND status='RENTED'").bind(o.unit_id,tenant,id).first();
  if(!unit)throw new RuleError('Unidade não está locada neste pedido.',409);
  const statements=[];
  if(input.type==='RETURN') {
   statements.push(db.prepare(`INSERT INTO stock_movements(id,tenant_id,store_id,product_id,type,quantity,previous_quantity,new_quantity,reference_type,reference_id,user_id,created_at) SELECT ?,tenant_id,store_id,product_id,'RETURN',1,quantity,quantity+1,'RENTAL_RETURN',?,?,? FROM inventories WHERE tenant_id=? AND store_id=? AND product_id=?`).bind(crypto.randomUUID(),id,actor.userId,now,tenant,o.store_id,o.product_id));
   statements.push(db.prepare('UPDATE inventories SET quantity=quantity+1 WHERE tenant_id=? AND store_id=? AND product_id=?').bind(tenant,o.store_id,o.product_id));
  }
  statements.push(db.prepare('UPDATE product_units SET status=?,order_id=?,updated_at=? WHERE id=?').bind(input.type==='RETURN'?'AVAILABLE':'SOLD',input.type==='RETURN'?null:id,now,o.unit_id));
  statements.push(db.prepare("UPDATE rental_closures SET status='COMPLETED',completed_at=?,processing_token=NULL,processing_until=NULL WHERE order_id=? AND processing_token=?").bind(now,id,token));
  await db.batch(statements);
  await audit(db,tenant,o,actor,'rental.close',input.type==='RETURN'?'Aparelho devolvido; parcelas futuras canceladas, dívidas vencidas preservadas':'Compra concluída após quitação confirmada',now);
 }finally{await db.prepare('UPDATE rental_closures SET processing_token=NULL,processing_until=NULL WHERE order_id=? AND processing_token=?').bind(id,token).run();}
}

/**
 * Controle dos boletos de todos os pedidos (inadimplência). Vencido = status OVERDUE no Asaas ou
 * em aberto com vencimento anterior a hoje (o Asaas pode atualizar o status com atraso).
 */
export type ReceivableFilter='overdue'|'open'|'paid'|'all';
export async function listReceivablesOverview(db:D1Database,tenant:string,actor:Actor,filter:ReceivableFilter,now=Date.now()) {
 requirePermission(actor.permissions,'ORDER_VIEW');
 if(!['overdue','open','paid','all'].includes(filter))throw new RuleError('Filtro inválido.',400);
 const today=dayKey(now);
 const scoped=actor.role!=='admin'&&actor.storeId?actor.storeId:null;
 const where=filter==='overdue'?"AND (r.status='OVERDUE' OR (r.status='OPEN' AND r.due_date<?))":filter==='open'?"AND r.status IN ('OPEN','OVERDUE')":filter==='paid'?"AND r.status='PAID'":'';
 const binds:unknown[]=[tenant];if(scoped)binds.push(scoped);if(filter==='overdue')binds.push(today);
 const rows=await db.prepare(`SELECT r.id,r.order_id AS orderId,r.kind,r.sequence,r.amount,r.due_date AS dueDate,r.status,r.provider_status AS providerStatus,r.invoice_url AS url,r.environment,r.provider_customer_id AS providerCustomerId,o.number AS orderNumber,o.type AS orderType,c.name AS customerName,c.document AS customerDocument,c.phone AS customerPhone,s.name AS storeName FROM order_receivables r JOIN orders o ON o.id=r.order_id JOIN customers c ON c.id=r.customer_id JOIN stores s ON s.id=r.store_id WHERE r.tenant_id=? ${scoped?'AND r.store_id=?':''} ${where} ORDER BY r.due_date,o.number,r.kind,r.sequence LIMIT 500`).bind(...binds).all<{id:string;orderId:string;kind:string;sequence:number;amount:number;dueDate:string;status:string;providerStatus:string;url:string;environment:string;providerCustomerId:string|null;orderNumber:number;orderType:string;customerName:string;customerDocument:string;customerPhone:string;storeName:string}>();
 const noon=(d:string)=>Date.parse(d+'T12:00:00Z');
 const items=(rows.results??[]).map(({providerCustomerId,...r})=>{const overdue=r.status==='OVERDUE'||(r.status==='OPEN'&&r.dueDate<today);return {...r,sequence:Number(r.sequence),amount:Number(r.amount),orderNumber:Number(r.orderNumber),overdue,daysOverdue:overdue?Math.max(0,Math.round((noon(today)-noon(r.dueDate))/86_400_000)):0,hasAsaasCustomer:!!providerCustomerId};});
 // Totais sobre todas as cobranças visíveis ao usuário, independentemente do filtro.
 const t=await db.prepare(`SELECT SUM(CASE WHEN status IN ('OPEN','OVERDUE') THEN amount ELSE 0 END) AS openAmount,SUM(CASE WHEN status='OVERDUE' OR (status='OPEN' AND due_date<?) THEN amount ELSE 0 END) AS overdueAmount,COUNT(DISTINCT CASE WHEN status='OVERDUE' OR (status='OPEN' AND due_date<?) THEN customer_id END) AS delinquentCustomers,SUM(CASE WHEN status='PAID' THEN amount ELSE 0 END) AS paidAmount,SUM(CASE WHEN status IN ('UNCERTAIN','REVIEW','CREATING') THEN 1 ELSE 0 END) AS needsReview FROM order_receivables WHERE tenant_id=? ${scoped?'AND store_id=?':''}`).bind(today,today,tenant,...(scoped?[scoped]:[])).first<Record<string,number|null>>();
 return {items,totals:{openAmount:Number(t?.openAmount??0),overdueAmount:Number(t?.overdueAmount??0),delinquentCustomers:Number(t?.delinquentCustomers??0),paidAmount:Number(t?.paidAmount??0),needsReview:Number(t?.needsReview??0)}};
}

type AsaasNotification={event?:string;enabled?:boolean;emailEnabledForCustomer?:boolean;smsEnabledForCustomer?:boolean;whatsappEnabledForCustomer?:boolean;phoneCallEnabledForCustomer?:boolean;scheduleOffset?:number};
/**
 * Lembretes do Asaas para o cliente da cobrança (GET /v3/customers/{id}/notifications). A API
 * informa a CONFIGURAÇÃO (evento, canais habilitados, antecedência), não o histórico de envios —
 * a tela deixa isso explícito. Nada é gravado: consulta sob demanda.
 */
export async function customerReminders(db:D1Database,tenant:string,receivableId:string,actor:Actor,fetcher?:BillingFetch) {
 const r=await loadReceivable(db,tenant,receivableId);await orderScope(db,tenant,r.order_id,actor);
 const c=await config(db,tenant,r.store_id);
 if(c.environment!==r.environment)throw new RuleError('Ambiente da cobrança divergente.',409);
 if(!r.provider_customer_id)throw new RuleError('Cliente ainda não cadastrado no Asaas: emita o boleto primeiro.',409);
 const res=await client(c,fetcher).call<{data?:AsaasNotification[]}>('GET',`/customers/${encodeURIComponent(r.provider_customer_id)}/notifications`);
 if(!Array.isArray(res.data))throw new RuleError('Resposta inválida do Asaas ao consultar os lembretes.',502);
 const channels=(n:AsaasNotification)=>[n.emailEnabledForCustomer&&'E-mail',n.smsEnabledForCustomer&&'SMS',n.whatsappEnabledForCustomer&&'WhatsApp',n.phoneCallEnabledForCustomer&&'Robô de voz'].filter((x):x is string=>!!x);
 return {reminders:res.data.filter(n=>typeof n.event==='string').map(n=>({event:n.event as string,enabled:n.enabled===true,channels:channels(n),scheduleOffset:typeof n.scheduleOffset==='number'?n.scheduleOffset:null}))};
}
