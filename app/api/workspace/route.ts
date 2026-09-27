import { createHash } from 'node:crypto';
import { getCurrentUser, isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { RuleError, type Actor } from '@/lib/domain';
import { commandSchema } from '@/lib/commands';
import { loadPermissions } from '@/lib/authz/service';
import { listStores, listProductsForSnapshot } from '@/lib/catalog/service';
import { listOrders, listUnits } from '@/lib/orders/service';
import { listContracts } from '@/lib/contracts/service';
import { getSignatureConfigSummary } from '@/lib/signature/service';
import { listOrderDocuments } from '@/lib/documents/service';
import { listStockMapForTenant, listTransfersForSnapshot } from '@/lib/inventory/service';
import { listSessionsForSnapshot } from '@/lib/cash/service';
import { listSalesForSnapshot } from '@/lib/sales/service';
import { getSystemRole, getDiscountLimitBp, listDiscountLimits } from '@/lib/sales/discount';
import { getPaymentConfigSummary, listOpenCharges, listPaymentTerminals, getChargeView, refreshCharge } from '@/lib/payments/service';
import { listAudit } from '@/lib/audit/service';
import { listTenantUsers } from '@/lib/users/service';
import { listCustomers, listSuppliers } from '@/lib/customers/service';
import { getFiscalStoreConfig, getFiscalDocumentXml, listFiscalDocumentsForSnapshot, listFiscalInutilizationsForSnapshot, getDanfeData, type FiscalStoreConfig, type FiscalDocumentSummary, type FiscalInutilizationSummary } from '@/lib/fiscal/service';
import { getNFCeStoreConfig, getNFCeDanfeData, type NFCeStoreConfig } from '@/lib/fiscal/nfce';
import { buildDanfeHtml, buildDanfeNfceHtml } from '@/lib/fiscal/danfe';
import { getSalesReport, getCashReport, getFiscalReport } from '@/lib/reports/service';
import { getFiscalJobsSummary } from '@/lib/fiscal/queue';
import { clientIp } from '@/lib/http/clientIp';
import { logger } from '@/lib/log';
import { withIdempotency } from '@/lib/idempotency';
import { readTextLimited, readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
import { dispatchCommand } from '@/lib/relationalCommands';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers});
type Row={id:string;name:string;state:string;revision:number;subscription_status:string;access_until:number;max_stores:number;role:string;store_id:string|null;display_name:string};
async function account(userId:string){return database().prepare('SELECT a.*, m.role, m.store_id, m.display_name FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=?').bind(userId).first<Row>()}
async function context(row:Row,userId:string){const permissions=await loadPermissions(database(),userId,row.id,row.role);return {actor:{userId,role:row.role,storeId:row.store_id,displayName:row.display_name,permissions} satisfies Actor,plan:{status:row.subscription_status,accessUntil:row.access_until,maxStores:row.max_stores}}}
// Fase 1–3 cortadas (cutover): todo o estado operacional (loja/produto/estoque/
// transferência/caixa/venda/auditoria/equipe/clientes/fornecedores/fiscal) vem das tabelas relacionais.
// Janelas do snapshot: a tela recarrega a cada 60 s, no foco e após cada operação; carregar todo o
// histórico da conta tornaria cada atualização mais lenta com o tempo. O que ficou de fora é
// buscado por páginas (GET ?history=sales|cash|audit&before=<ms>).
const SNAPSHOT_WINDOW_MS=90*24*60*60*1000;
const SNAPSHOT_SALES_LIMIT=2000,SNAPSHOT_CASH_LIMIT=500,SNAPSHOT_AUDIT_LIMIT=300;
const HISTORY_PAGE=50,HISTORY_AUDIT_PAGE=100;
async function fullState(db:D1Database,tenantId:string,actor:Actor){
 const isAdmin=actor.role==='admin';
 const scope=isAdmin?null:actor.storeId;
 const since=Date.now()-SNAPSHOT_WINDOW_MS;
 const canViewUsers=actor.permissions.has('USER_VIEW');
 const canViewCustomers=actor.permissions.has('CUSTOMER_VIEW');
 const canViewSuppliers=actor.permissions.has('SUPPLIER_VIEW');
 const canViewFiscal=actor.permissions.has('FISCAL_VIEW');
 // Auditoria traz IP, antes/depois e ações de toda a equipe: só para quem tem AUDIT_VIEW.
 const canViewAudit=actor.permissions.has('AUDIT_VIEW');
 const [stores,products,stock,transfers,cash,sales,relationalAudit,users,customers,suppliers]=await Promise.all([
  listStores(db,tenantId),listProductsForSnapshot(db,tenantId),listStockMapForTenant(db,tenantId),listTransfersForSnapshot(db,tenantId),
  listSessionsForSnapshot(db,tenantId,{since,limit:SNAPSHOT_CASH_LIMIT,storeId:scope}),listSalesForSnapshot(db,tenantId,{since,limit:SNAPSHOT_SALES_LIMIT,storeId:scope}),canViewAudit?listAudit(db,tenantId,{limit:SNAPSHOT_AUDIT_LIMIT,storeId:scope}):Promise.resolve([]),
  canViewUsers?listTenantUsers(db,tenantId,actor):Promise.resolve([]),
  canViewCustomers?listCustomers(db,tenantId,actor):Promise.resolve([]),
  canViewSuppliers?listSuppliers(db,tenantId,actor):Promise.resolve([]),
 ]);
 const storeRecords=stores.map(s=>({id:s.id,name:s.name,legalName:s.legalName,cnpj:s.cnpj,ie:s.ie,regime:s.regime,uf:s.uf,city:s.city,municipalityCode:s.municipalityCode,address:s.address,number:s.number,district:s.district,zip:s.zip,modalities:s.modalities}));
 let fiscalConfigs: Record<string, FiscalStoreConfig> | undefined = undefined;
 let fiscalDocuments: Record<string, FiscalDocumentSummary> | undefined = undefined;
 let fiscalInutilizations: Record<string, FiscalInutilizationSummary[]> | undefined = undefined;
 let nfceConfigs: Record<string, NFCeStoreConfig> | undefined = undefined;
 if (canViewFiscal) {
  if (stores.length) {
   const configs = await Promise.all(stores.map(s => getFiscalStoreConfig(db, tenantId, s.id, actor)));
   fiscalConfigs = Object.fromEntries(configs.map(c => [c.storeId, c]));
   const nfceCfgs = await Promise.all(stores.map(s => getNFCeStoreConfig(db, tenantId, s.id, actor)));
   nfceConfigs = Object.fromEntries(nfceCfgs.map(c => [c.storeId, c]));
  }
  const inWindow=new Set(sales.map(x=>x.id));
  fiscalDocuments = Object.fromEntries(Object.entries(await listFiscalDocumentsForSnapshot(db, tenantId, actor)).filter(([saleId])=>inWindow.has(saleId)));
  fiscalInutilizations = await listFiscalInutilizationsForSnapshot(db, tenantId, actor);
 }
 // §53: limite de desconto do próprio usuário (a tela decide quando pedir supervisor) e, para
 // quem pode configurar, a lista de limites por papel.
 const myDiscountLimitBp=await getDiscountLimitBp(db,tenantId,await getSystemRole(db,tenantId,actor.userId));
 const discountLimits=actor.permissions.has('SALE_DISCOUNT_CONFIG')?await listDiscountLimits(db,tenantId,actor):undefined;
 // Pagamentos integrados: quem configura vê o resumo completo (sem segredos); quem só vende
 // vê se Pix/maquininha estão prontos na loja. Cobranças abertas permitem retomar a espera.
 const canConfigPayments=actor.permissions.has('PAYMENT_CONFIG');
 const paymentConfigs=Object.fromEntries(await Promise.all(stores.map(async s=>{const c=await getPaymentConfigSummary(db,tenantId,s.id);return [s.id,canConfigPayments?c:{storeId:c.storeId,provider:c.provider,configured:c.configured,pixReady:c.pixReady,terminalReady:c.terminalReady,hasWebhookSecret:false,qrExternalPosId:'',defaultTerminalId:'',webhookPath:null,updatedAt:null}] as const})));
 // Membro sem loja atribuída (storeId nulo) enxerga todas as lojas, como já acontece nas regras
 // de acesso do backend (requireStoreAccess); antes o filtro abaixo escondia tudo dele.
 const inScope=(storeId:string|undefined)=>!actor.storeId||storeId===actor.storeId;
 const openCharges=(await listOpenCharges(db,tenantId)).filter(ch=>isAdmin||sales.some(s=>s.id===ch.saleId&&inScope(s.storeId))).map(ch=>({...ch,qrSvg:null}));
 // Pedidos (venda com contrato/locação) e unidades com chassi/IMEI.
 const orders=await listOrders(db,tenantId,actor);
 const contracts=await listContracts(db,tenantId,actor);
 // Assinatura eletrônica: quem configura vê o resumo (sem segredos); os demais só se está pronta.
 const canConfigSignature=actor.permissions.has('SIGNATURE_CONFIG');
 const signatureConfigs=Object.fromEntries(await Promise.all(stores.map(async s=>{const c=await getSignatureConfigSummary(db,tenantId,s.id);return [s.id,canConfigSignature?c:{...c,hasWebhookSecret:false,webhookPath:null}] as const})));
 const documents=await listOrderDocuments(db,tenantId,actor);
 const units=(actor.permissions.has('STOCK_VIEW')||actor.permissions.has('ORDER_VIEW'))?(await listUnits(db,tenantId)).filter(u=>isAdmin||inScope(u.storeId)):[];
 const hasAny=async(table:string,col:string)=>!!(await db.prepare(`SELECT 1 AS one FROM ${table} WHERE tenant_id = ?${scope?` AND store_id = ?`:''} LIMIT 1`).bind(tenantId,...(scope?[scope]:[])).first());
 const history={windowStart:since,salesTruncated:sales.length>=SNAPSHOT_SALES_LIMIT,hasSales:sales.length>0||await hasAny('sales','created_at'),hasCash:cash.length>0||await hasAny('cash_sessions','opened_at'),auditLimit:SNAPSHOT_AUDIT_LIMIT};
 if(isAdmin)return {history,stores:storeRecords,products,stock,transfers,cash,sales,audit:relationalAudit,users,customers,suppliers,fiscalConfigs,fiscalDocuments,fiscalInutilizations,nfceConfigs,myDiscountLimitBp,discountLimits,paymentConfigs,openCharges,orders,units,contracts,documents,signatureConfigs};
 return {
  history,stores:storeRecords,products:products.map(p=>({...p,cost:0})),stock,transfers,
  cash:cash.filter(c=>inScope(c.storeId)).map(c=>c.closedAt?c:{...c,opening:0}),
  sales:sales.filter(s=>inScope(s.storeId)),
  audit:relationalAudit.filter(a=>inScope(a.storeId)),
  users,customers,suppliers,fiscalConfigs,fiscalDocuments,fiscalInutilizations,nfceConfigs,myDiscountLimitBp,discountLimits,paymentConfigs,openCharges,orders,units,contracts,documents,signatureConfigs,
 };
}
async function snapshot(row:Row,userId:string){const {actor,plan}=await context(row,userId);return {account:{name:row.name,subscription:plan},actor:{...actor,permissions:Array.from(actor.permissions)},state:await fullState(database(),row.id,actor),revision:row.revision}}
export async function GET(request:Request){
 try{
  const user=await getCurrentUser();if(!user)return reply({error:'Entre para acessar sua conta.',signIn:true},401);
  const row=await account(user.userId);if(!row)return reply({error:'Conta não encontrada para este usuário.',signIn:true},401);
  const danfeSaleId=new URL(request.url).searchParams.get('danfe');
  if(danfeSaleId){
   const {actor}=await context(row,user.userId);
   const db=database();
   const doc=await db.prepare('SELECT model FROM fiscal_documents WHERE sale_id=? AND tenant_id=?').bind(danfeSaleId,row.id).first<{model:string}>();
   const html = doc?.model==='65'
    ? buildDanfeNfceHtml(await getNFCeDanfeData(db,row.id,danfeSaleId,actor))
    : buildDanfeHtml(await getDanfeData(db,row.id,danfeSaleId,actor));
   return new Response(html,{status:200,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store'}});
  }
  const params0=new URL(request.url).searchParams;
  // Status de uma cobrança integrada (a tela do caixa consulta enquanto espera). Sincroniza com
  // o provedor no máximo a cada 2 s por cobrança; é idempotente (só reflete a verdade do provedor).
  const chargeId=params0.get('charge');
  if(chargeId){const {actor}=await context(row,user.userId);const db=database();return reply(params0.get('sync')==='0'?await getChargeView(db,row.id,chargeId,actor):await refreshCharge(db,row.id,chargeId,actor))}
  const terminalsStore=params0.get('payment-terminals');
  if(terminalsStore){const {actor}=await context(row,user.userId);return reply({terminals:await listPaymentTerminals(database(),row.id,terminalsStore,actor)})}
  const historyType=params0.get('history');
  if(historyType){
   const {actor}=await context(row,user.userId);const db=database();
   const scope=actor.role==='admin'?null:actor.storeId;
   const beforeRaw=Number(params0.get('before'));
   if(!Number.isFinite(beforeRaw)||beforeRaw<=0)return reply({error:'Informe o ponto de corte (before) em milissegundos.'},400);
   if(historyType==='sales'){
    const page=await listSalesForSnapshot(db,row.id,{before:beforeRaw,limit:HISTORY_PAGE,storeId:scope});
    let fiscalDocuments={};
    if(actor.permissions.has('FISCAL_VIEW')){const ids=new Set(page.map(x=>x.id));fiscalDocuments=Object.fromEntries(Object.entries(await listFiscalDocumentsForSnapshot(db,row.id,actor)).filter(([saleId])=>ids.has(saleId)));}
    return reply({sales:page,fiscalDocuments,hasMore:page.length===HISTORY_PAGE});
   }
   if(historyType==='cash'){
    const page=await listSessionsForSnapshot(db,row.id,{before:beforeRaw,limit:HISTORY_PAGE,storeId:scope});
    return reply({cash:actor.role==='admin'?page:page.map(c=>c.closedAt?c:{...c,opening:0}),hasMore:page.length===HISTORY_PAGE});
   }
   if(historyType==='audit'){
    if(!actor.permissions.has('AUDIT_VIEW'))return reply({error:'Sem permissão para ver o histórico.'},403);
    const page=await listAudit(db,row.id,{before:beforeRaw,limit:HISTORY_AUDIT_PAGE,storeId:scope});
    return reply({audit:page,hasMore:page.length===HISTORY_AUDIT_PAGE});
   }
   return reply({error:'Histórico desconhecido.'},400);
  }
  const fiscalXmlId=params0.get('fiscal-xml');
  if(fiscalXmlId){const {actor}=await context(row,user.userId);return reply(await getFiscalDocumentXml(database(),row.id,fiscalXmlId,actor))}
  const reportType=new URL(request.url).searchParams.get('report');
  if(reportType){
   const {actor}=await context(row,user.userId);
   const db=database();
   const params=new URL(request.url).searchParams;
   const storeId=params.get('storeId')||undefined;
   const from=params.get('from')?Number(params.get('from')):undefined;
   const to=params.get('to')?Number(params.get('to')):undefined;
   if((from!==undefined&&!Number.isFinite(from))||(to!==undefined&&!Number.isFinite(to)))return reply({error:'Período inválido: from e to devem ser timestamps em milissegundos.'},400);
   if(reportType==='sales')return reply(await getSalesReport(db,row.id,actor,{storeId,from,to}));
   if(reportType==='cash')return reply(await getCashReport(db,row.id,actor,{storeId}));
   if(reportType==='fiscal')return reply(await getFiscalReport(db,row.id,actor));
   if(reportType==='fiscal-jobs')return reply(await getFiscalJobsSummary(db,row.id,actor));
   return reply({error:'Relatório desconhecido.'},400);
  }
  return reply(await snapshot(row,user.userId));
 }catch(error){
  if(error instanceof RuleError)return reply({error:error.message},error.status);
  const requestId=crypto.randomUUID();logger.error('workspace.leitura.erro',{requestId,error});return reply({error:'Não foi possível carregar os dados. Tente novamente.',requestId},503);
 }
}
export async function POST(request:Request){
 try{
  if(!isSameOrigin(request))return reply({error:'Origem da solicitação inválida.'},403);
  const user=await getCurrentUser();if(!user)return reply({error:'Sessão encerrada. Entre novamente.',signIn:true},401);
  if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'Formato inválido.'},415);
  let raw:string;try{raw=await readTextLimited(request,262144)}catch(e){if(e instanceof BodyTooLargeError)return reply({error:'Solicitação muito grande.'},413);throw e}let body;try{body=JSON.parse(raw)}catch{return reply({error:'Solicitação inválida.'},400)}
  if(!body||typeof body!=='object')return reply({error:'Solicitação inválida.'},400);
  let row=await account(user.userId);
  if(!row)return reply({error:'Crie sua conta para continuar.'},403);
  if(typeof body.key!=='string'||!/^[a-f0-9-]{36}$/i.test(body.key))return reply({error:'Identificador de operação inválido.'},400);
  const db=database();const {actor,plan}=await context(row,user.userId);const now=Date.now();
  const parsed=commandSchema.safeParse(body.command);
  if(!parsed.success)return reply({error:'Confira os campos: '+parsed.error.issues.map(x=>x.message).join('; ')},400);
  const command=parsed.data;
  // Hash do comando: a idempotência guarda o fingerprint no banco, e o comando pode conter a
  // senha de um supervisor (§53) — nunca gravar em texto.
  const fingerprint=createHash('sha256').update(JSON.stringify({actor:actor.userId,command})).digest('hex');
  const ip=clientIp(request.headers);
  const {resultId}=await withIdempotency(db,row.id,body.key,fingerprint,()=>dispatchCommand(db,row!.id,actor,plan,command,now,{ip,correlationId:body.key}));
  await db.prepare('UPDATE accounts SET revision=revision+1 WHERE id=?').bind(row.id).run();
  row={...row,revision:row.revision+1};
  return reply({...(await snapshot(row,user.userId)),resultId});
 }catch(error){if(error instanceof RuleError)return reply({error:error.message},error.status);const requestId=crypto.randomUUID();logger.error('workspace.escrita.erro',{requestId,error});return reply({error:'Não foi possível salvar. Seus campos foram preservados; tente novamente.',requestId},503)}
}