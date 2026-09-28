import { randomBytes, timingSafeEqual } from 'node:crypto';
import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { Actor } from '../domain.ts';
import { encryptPayload, decryptPayload } from '../fiscal/certificate.ts';
import { recordAudit } from '../audit/service.ts';
import { dayKey } from '../time.ts';
import { AsaasClient, AsaasError, type AsaasPayment, type BillingFetch } from './asaas.ts';
import { PDFDocument } from 'pdf-lib';
import { storeDocument } from '../documents/service.ts';
import type { ObjectStorage } from '../storage/index.ts';

type Config = {store_id: string; tenant_id: string; environment: string; api_key_enc: string; webhook_secret_enc: string; webhook_key: string; notifications_enabled: number};
type Order = {id: string; number: number; store_id: string; customer_id: string; type: string; status: string; total: number; down_payment: number; installments: number; first_due_date: string; monthly_amount: number; adhesion_amount: number; adhesion_billing: string; due_day: number; unit_id: string; product_id: string};
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
/** Resumo da configuração Asaas da loja para a tela (nunca devolve API key nem token do webhook). */
export async function getBillingConfigSummary(db: D1Database, tenant: string, store: string, actor: Actor) {
 requirePermission(actor.permissions,'PAYMENT_CONFIG'); requireStoreAccess(actor,store);
 if (!await db.prepare('SELECT id FROM stores WHERE id = ? AND tenant_id = ?').bind(store,tenant).first()) throw new RuleError('Loja não encontrada.',404);
 const c=await db.prepare('SELECT environment, webhook_key AS webhookKey, notifications_enabled AS notificationsEnabled, updated_at AS updatedAt FROM order_billing_configs WHERE tenant_id = ? AND store_id = ?').bind(tenant,store).first<{environment:string;webhookKey:string;notificationsEnabled:number;updatedAt:number}>();
 const issued=await db.prepare("SELECT id FROM order_receivables WHERE store_id = ? AND tenant_id = ? LIMIT 1").bind(store,tenant).first();
 return c?{configured:true,environment:c.environment,notificationsEnabled:!!c.notificationsEnabled,webhookPath:`/api/billing/asaas/webhook/${c.webhookKey}`,updatedAt:Number(c.updatedAt),environmentLocked:!!issued}:{configured:false,environment:'',notificationsEnabled:false,webhookPath:null,updatedAt:null,environmentLocked:false};
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
 // A 1ª data vem do pedido (escolhida pelo vendedor). Só pedidos de locação antigos, sem ela, usam a informada na prévia.
 const first=o.first_due_date||(o.type==='LOCACAO'?String(input.firstDueDate??''):'');
 if (!validBillingDate(first) || first<dayKey(now)) throw new RuleError('Informe o primeiro vencimento, sem data passada.',400);
 if (o.type==='LOCACAO' && Number(first.slice(-2))!==Number(o.due_day)) throw new RuleError('O primeiro vencimento deve respeitar o dia do contrato.',400);
 const fine=o.type==='LOCACAO'?200:input.fineBp, interest=o.type==='LOCACAO'?100:input.interestBp;
 if (![fine,interest].every(v=>Number.isInteger(v)&&v!>=0&&v!<=10000)) throw new RuleError('Informe multa e juros da venda, inclusive zero se não houver.',400);
 const total=o.type==='LOCACAO'?Number(o.monthly_amount)*12:Number(o.total)-Number(o.down_payment);
 const unit=Math.floor(total/count);
 if (unit<1) throw new RuleError('Valor de parcela inválido.',400);
 const entries=monthlyDates(first,count).map((due,i)=>({kind:o.type==='LOCACAO'?'RENT':'INSTALLMENT',sequence:i+1,amount:i===count-1?total-unit*(count-1):unit,due}));
 // Adesão não gera boleto: é paga na loja no ato (decisão do usuário). Locação = 12 boletos.
 await db.batch(entries.map(e=>db.prepare(`INSERT INTO order_receivables (id,tenant_id,store_id,order_id,customer_id,kind,sequence,amount,due_date,fine_bp,interest_bp,environment,status,external_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?) ON CONFLICT(order_id,kind,sequence) DO NOTHING`).bind(crypto.randomUUID(),tenant,o.store_id,id,o.customer_id,e.kind,e.sequence,e.amount,e.due,fine,interest,c.environment,`omnihub-${id}-${e.kind}-${e.sequence}`,now,now)));
 await audit(db,tenant,o,actor,'billing.prepare','Cronograma de boletos preparado para revisão',now);
}
async function loadReceivable(db:D1Database,tenant:string,id:string) {const r=await db.prepare('SELECT * FROM order_receivables WHERE id = ? AND tenant_id = ?').bind(id,tenant).first<Receivable>();if(!r)throw new RuleError('Cobrança não encontrada.',404);return r;}
// Telefone no formato do Asaas (DDD + número, só dígitos): celular (11 dígitos, começa com 9 após o
// DDD) vai em mobilePhone; fixo (10 dígitos) em phone; qualquer outro formato não é enviado (o
// telefone é opcional no Asaas e um valor fora do padrão recusaria o cadastro inteiro).
const ASAAS_REF_MAX=100;
function assertAsaasRef(ref:string):string{if(ref.length>ASAAS_REF_MAX)throw new RuleError(`Referência externa com ${ref.length} caracteres (o Asaas aceita até ${ASAAS_REF_MAX}). Nada foi enviado.`,500);return ref;}
const KIND_LABEL:Record<string,string>={INSTALLMENT:'Parcela',RENT:'Mensalidade',ADHESION:'Adesão',RESIDUAL:'Compra residual',DAMAGE:'Avarias'};
export function asaasPhone(raw:string):{mobilePhone?:string;phone?:string}{
 const d=String(raw??'').replace(/\D/g,'').replace(/^0+/,'').replace(/^55(?=\d{10,11}$)/,'');
 if(/^\d{2}9\d{8}$/.test(d))return {mobilePhone:d};
 if(/^\d{2}[2-5]\d{7}$/.test(d))return {phone:d};
 return {};
}
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
  // externalReference do Asaas aceita no máximo 100 caracteres (confirmado pelo usuário no Sandbox).
  // O id do cliente já é único; cada loja usa a própria conta Asaas.
  const ref=assertAsaasRef(`omnihub-${r.customer_id}`);
  const customers=await api.call<{data:{id:string;cpfCnpj:string}[];hasMore:boolean}>('GET','/customers?limit=100&externalReference='+encodeURIComponent(ref));
  if(!Array.isArray(customers.data)||customers.data.length>1||customers.hasMore)throw new RuleError('Cadastro duplicado no Asaas; confira o cliente.',409);
  let cust=customers.data[0];
  if(!cust)cust=await api.call('POST','/customers',{name:customer.name,cpfCnpj:customer.document.replace(/\D/g,''),email:customer.email||undefined,...asaasPhone(customer.phone),externalReference:ref,notificationDisabled:!c.notifications_enabled});
  if(!cust?.id || cust.cpfCnpj.replace(/\D/g,'')!==customer.document.replace(/\D/g,''))throw new RuleError('Cliente retornado pelo Asaas diverge do cadastro.',409);
  await db.prepare('UPDATE order_receivables SET provider_customer_id=? WHERE id=?').bind(cust.id,id).run();r.provider_customer_id=cust.id;
  paymentStarted=true;
  const p=await api.createPayment({customer:cust.id,billingType:'BOLETO',value:Number(r.amount)/100,dueDate:r.due_date,externalReference:assertAsaasRef(r.external_ref),description:`Pedido #${o.number} - ${KIND_LABEL[r.kind]??r.kind} ${r.sequence}`,...(Number(r.fine_bp)>0?{fine:{value:Number(r.fine_bp)/100,type:'PERCENTAGE'}}:{}),...(Number(r.interest_bp)>0?{interest:{value:Number(r.interest_bp)/100}}:{})});
  await applyPayment(db,r,p,now);
  await audit(db,tenant,o,actor,'billing.issue','Boleto emitido e vinculado ao pedido',now);
 }catch(error){
  // Recusa explícita do Asaas (4xx com motivo) = nada foi criado lá: volta a Preparado para corrigir e
  // reenviar. Incerto só quando a comunicação falhou/resposta estranha (AsaasError.uncertain) ou
  // quando a falha veio depois de o Asaas aceitar a cobrança (ex.: divergência na conferência).
  const uncertain=error instanceof AsaasError?error.uncertain:paymentStarted;
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
// overdue = vencidos; upcoming = a vencer (em aberto, vencimento de hoje em diante); open = os dois;
// paid = pagos; all = todos, inclusive preparados e cancelados.
export type ReceivableFilter='overdue'|'upcoming'|'open'|'paid'|'all';
export async function listReceivablesOverview(db:D1Database,tenant:string,actor:Actor,filter:ReceivableFilter,now=Date.now()) {
 requirePermission(actor.permissions,'ORDER_VIEW');
 if(!['overdue','upcoming','open','paid','all'].includes(filter))throw new RuleError('Filtro inválido.',400);
 const today=dayKey(now);
 const scoped=actor.role!=='admin'&&actor.storeId?actor.storeId:null;
 const where=filter==='overdue'?"AND (r.status='OVERDUE' OR (r.status='OPEN' AND r.due_date<?))":filter==='upcoming'?"AND r.status='OPEN' AND r.due_date>=?":filter==='open'?"AND r.status IN ('OPEN','OVERDUE')":filter==='paid'?"AND r.status='PAID'":'';
 const binds:unknown[]=[tenant];if(scoped)binds.push(scoped);if(filter==='overdue'||filter==='upcoming')binds.push(today);
 const rows=await db.prepare(`SELECT r.id,r.order_id AS orderId,r.kind,r.sequence,r.amount,r.due_date AS dueDate,r.status,r.provider_status AS providerStatus,r.invoice_url AS url,r.environment,r.provider_customer_id AS providerCustomerId,o.number AS orderNumber,o.type AS orderType,c.name AS customerName,c.document AS customerDocument,c.phone AS customerPhone,s.name AS storeName FROM order_receivables r JOIN orders o ON o.id=r.order_id JOIN customers c ON c.id=r.customer_id JOIN stores s ON s.id=r.store_id WHERE r.tenant_id=? ${scoped?'AND r.store_id=?':''} ${where} ORDER BY r.due_date,o.number,r.kind,r.sequence LIMIT 500`).bind(...binds).all<{id:string;orderId:string;kind:string;sequence:number;amount:number;dueDate:string;status:string;providerStatus:string;url:string;environment:string;providerCustomerId:string|null;orderNumber:number;orderType:string;customerName:string;customerDocument:string;customerPhone:string;storeName:string}>();
 const noon=(d:string)=>Date.parse(d+'T12:00:00Z');
 const items=(rows.results??[]).map(({providerCustomerId,...r})=>{const overdue=r.status==='OVERDUE'||(r.status==='OPEN'&&r.dueDate<today);return {...r,sequence:Number(r.sequence),amount:Number(r.amount),orderNumber:Number(r.orderNumber),overdue,daysOverdue:overdue?Math.max(0,Math.round((noon(today)-noon(r.dueDate))/86_400_000)):0,hasAsaasCustomer:!!providerCustomerId};});
 // Totais sobre todas as cobranças visíveis ao usuário, independentemente do filtro.
 const t=await db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='OVERDUE' OR (status='OPEN' AND due_date<?) THEN amount ELSE 0 END),0) AS overdueAmount,COUNT(CASE WHEN status='OVERDUE' OR (status='OPEN' AND due_date<?) THEN 1 END) AS overdueCount,COUNT(DISTINCT CASE WHEN status='OVERDUE' OR (status='OPEN' AND due_date<?) THEN customer_id END) AS delinquentCustomers,COALESCE(SUM(CASE WHEN status='OPEN' AND due_date>=? THEN amount ELSE 0 END),0) AS upcomingAmount,COUNT(CASE WHEN status='OPEN' AND due_date>=? THEN 1 END) AS upcomingCount,COALESCE(SUM(CASE WHEN status IN ('OPEN','OVERDUE') THEN amount ELSE 0 END),0) AS openAmount,COALESCE(SUM(CASE WHEN status='PAID' THEN amount ELSE 0 END),0) AS paidAmount,COUNT(CASE WHEN status='PAID' THEN 1 END) AS paidCount,COUNT(*) AS allCount,COUNT(CASE WHEN status IN ('UNCERTAIN','REVIEW','CREATING') THEN 1 END) AS needsReview FROM order_receivables WHERE tenant_id=? ${scoped?'AND store_id=?':''}`).bind(today,today,today,today,today,tenant,...(scoped?[scoped]:[])).first<Record<string,number|string|null>>();
 // Sempre número (0 quando não há cobrança): somas/contagens podem voltar nulas ou como texto.
 const n=(v:unknown)=>{const x=Number(v??0);return Number.isFinite(x)?x:0;};
 return {items,totals:{overdueAmount:n(t?.overdueAmount),overdueCount:n(t?.overdueCount),delinquentCustomers:n(t?.delinquentCustomers),upcomingAmount:n(t?.upcomingAmount),upcomingCount:n(t?.upcomingCount),openAmount:n(t?.openAmount),paidAmount:n(t?.paidAmount),paidCount:n(t?.paidCount),allCount:n(t?.allCount),needsReview:n(t?.needsReview)}};
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

/**
 * Emite de uma vez todos os boletos em rascunho do pedido (a loja entrega o carnê no ato da compra).
 * Em sequência, na ordem de vencimento, reaproveitando o mesmo cliente no Asaas. Para no primeiro
 * erro e informa quantos saíram — os já emitidos continuam válidos e "Emitir todos" retoma dali.
 */
export async function issueAllReceivables(db:D1Database,tenant:string,orderId:string,actor:Actor,fetcher?:BillingFetch,now=Date.now()):Promise<{issued:number;total:number;error:string|null}> {
 await orderScope(db,tenant,orderId,actor,'ORDER_CREATE');
 const rows=(await db.prepare("SELECT id FROM order_receivables WHERE tenant_id=? AND order_id=? AND status='DRAFT' ORDER BY due_date,kind,sequence").bind(tenant,orderId).all<{id:string}>()).results??[];
 if(!rows.length)throw new RuleError('Não há boletos preparados para emitir neste pedido.',409);
 let issued=0;
 for(const r of rows){
  try{await issueReceivable(db,tenant,r.id,actor,fetcher,now);issued++;}
  catch(error){return {issued,total:rows.length,error:error instanceof RuleError?error.message:'Falha ao emitir; consulte a cobrança no Asaas antes de repetir.'};}
 }
 return {issued,total:rows.length,error:null};
}

const BOLETO_PDF_MAX=5*1024*1024;
function isAsaasHttps(raw:string):boolean{try{const u=new URL(raw);return u.protocol==='https:'&&(u.hostname==='asaas.com'||u.hostname.endsWith('.asaas.com'));}catch{return false;}}
/**
 * Junta os PDFs dos boletos em aberto do pedido num único arquivo (carnê), salvo em Documentos do
 * pedido e baixável para enviar ao cliente. Só baixa de endereços https do próprio Asaas (o link
 * vem do Asaas e já foi validado na conciliação) e confere que cada arquivo é PDF. Gerar de novo
 * substitui o carnê anterior (exclusão lógica).
 */
export async function mergeOrderBoletos(db:D1Database,storage:ObjectStorage,tenant:string,orderId:string,actor:Actor,fetcher:BillingFetch=fetch,now=Date.now()):Promise<{documentId:string;count:number}> {
 const o=await orderScope(db,tenant,orderId,actor);
 const rows=(await db.prepare("SELECT kind,sequence,invoice_url AS url FROM order_receivables WHERE tenant_id=? AND order_id=? AND status IN ('OPEN','OVERDUE') AND invoice_url<>'' ORDER BY due_date,kind,sequence").bind(tenant,orderId).all<{kind:string;sequence:number;url:string}>()).results??[];
 if(!rows.length)throw new RuleError('Nenhum boleto emitido e em aberto neste pedido para juntar.',409);
 const out=await PDFDocument.create();
 for(const r of rows){
  const label=`${KIND_LABEL[r.kind]??r.kind} ${r.sequence}`;
  if(!isAsaasHttps(r.url))throw new RuleError(`Link do boleto (${label}) não é do Asaas. Consulte a cobrança antes.`,409);
  let res:Response;
  try{res=await fetcher(r.url,{signal:AbortSignal.timeout(30_000),redirect:'follow'});}catch{throw new RuleError(`Não foi possível baixar o boleto (${label}) do Asaas. Tente de novo.`,503);}
  if(res.url&&!isAsaasHttps(res.url))throw new RuleError(`O Asaas redirecionou o boleto (${label}) para fora do domínio dele. Nada foi salvo.`,502);
  if(!res.ok)throw new RuleError(`O Asaas não entregou o PDF do boleto (${label}) (HTTP ${res.status}).`,502);
  if(Number(res.headers.get('content-length')??0)>BOLETO_PDF_MAX)throw new RuleError(`PDF do boleto (${label}) grande demais.`,502);
  const bytes=new Uint8Array(await res.arrayBuffer());
  if(bytes.length>BOLETO_PDF_MAX||!(bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46))throw new RuleError(`O Asaas não devolveu um PDF para o boleto (${label}).`,502);
  const src=await PDFDocument.load(bytes,{ignoreEncryption:true});
  for(const page of await out.copyPages(src,src.getPageIndices()))out.addPage(page);
 }
 out.setTitle(`Boletos do pedido #${o.number}`);
 const pdf=await out.save();
 await db.prepare("UPDATE documents SET deleted_at=?, deleted_by=? WHERE tenant_id=? AND order_id=? AND type='BOLETOS' AND deleted_at IS NULL").bind(now,actor.userId,tenant,orderId).run();
 const doc=await storeDocument(db,storage,tenant,{storeId:o.store_id,customerId:o.customer_id,orderId,type:'BOLETOS',description:`Boletos do pedido #${o.number} (${rows.length} em aberto, arquivo único)`,originalFilename:`boletos-pedido-${o.number}.pdf`,bytes:pdf,source:'system'},actor,now);
 await audit(db,tenant,o,actor,'billing.boletos.pdf',`PDF único com ${rows.length} boleto(s) salvo em Documentos`,now);
 return {documentId:doc.id,count:rows.length};
}
