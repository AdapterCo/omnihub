import { getChatGPTUser } from '@/app/chatgpt-auth';
import { database } from '@/db/database';
import { RuleError, type Actor } from '@/lib/domain';
import { commandSchema } from '@/lib/commands';
import { loadPermissions } from '@/lib/authz/service';
import { listStores, listProductsForSnapshot } from '@/lib/catalog/service';
import { listStockMapForTenant, listTransfersForSnapshot } from '@/lib/inventory/service';
import { listSessionsForSnapshot } from '@/lib/cash/service';
import { listSalesForSnapshot } from '@/lib/sales/service';
import { listAudit } from '@/lib/audit/service';
import { listTenantUsers } from '@/lib/users/service';
import { listCustomers, listSuppliers } from '@/lib/customers/service';
import { getFiscalStoreConfig, listFiscalDocumentsForSnapshot, listFiscalInutilizationsForSnapshot, getDanfeData, type FiscalStoreConfig, type FiscalDocumentSummary, type FiscalInutilizationSummary } from '@/lib/fiscal/service';
import { getNFCeStoreConfig, getNFCeDanfeData, type NFCeStoreConfig } from '@/lib/fiscal/nfce';
import { buildDanfeHtml, buildDanfeNfceHtml } from '@/lib/fiscal/danfe';
import { getSalesReport, getCashReport, getFiscalReport } from '@/lib/reports/service';
import { getFiscalJobsSummary } from '@/lib/fiscal/queue';
import { withIdempotency } from '@/lib/idempotency';
import { dispatchCommand } from '@/lib/relationalCommands';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers});
type Row={id:string;name:string;state:string;revision:number;subscription_status:string;access_until:number;max_stores:number;role:string;store_id:string|null;display_name:string};
async function account(userId:string){return database().prepare('SELECT a.*, m.role, m.store_id, m.display_name FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=?').bind(userId).first<Row>()}
async function context(row:Row,userId:string){const permissions=await loadPermissions(database(),userId,row.id,row.role);return {actor:{userId,role:row.role,storeId:row.store_id,displayName:row.display_name,permissions} satisfies Actor,plan:{status:row.subscription_status,accessUntil:row.access_until,maxStores:row.max_stores}}}
// Fase 1–3 cortadas (cutover): todo o estado operacional (loja/produto/estoque/
// transferência/caixa/venda/auditoria/equipe/clientes/fornecedores/fiscal) vem das tabelas relacionais.
async function fullState(db:D1Database,tenantId:string,actor:Actor){
 const isAdmin=actor.role==='admin';
 const canViewUsers=actor.permissions.has('USER_VIEW');
 const canViewCustomers=actor.permissions.has('CUSTOMER_VIEW');
 const canViewSuppliers=actor.permissions.has('SUPPLIER_VIEW');
 const canViewFiscal=actor.permissions.has('FISCAL_VIEW');
 const [stores,products,stock,transfers,cash,sales,relationalAudit,users,customers,suppliers]=await Promise.all([
  listStores(db,tenantId),listProductsForSnapshot(db,tenantId),listStockMapForTenant(db,tenantId),listTransfersForSnapshot(db,tenantId),
  listSessionsForSnapshot(db,tenantId),listSalesForSnapshot(db,tenantId),listAudit(db,tenantId),
  canViewUsers?listTenantUsers(db,tenantId,actor):Promise.resolve([]),
  canViewCustomers?listCustomers(db,tenantId,actor):Promise.resolve([]),
  canViewSuppliers?listSuppliers(db,tenantId,actor):Promise.resolve([]),
 ]);
 const storeRecords=stores.map(s=>({id:s.id,name:s.name,legalName:s.legalName,cnpj:s.cnpj,ie:s.ie,regime:s.regime,uf:s.uf,city:s.city,municipalityCode:s.municipalityCode,address:s.address,number:s.number,district:s.district,zip:s.zip}));
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
  fiscalDocuments = await listFiscalDocumentsForSnapshot(db, tenantId, actor);
  fiscalInutilizations = await listFiscalInutilizationsForSnapshot(db, tenantId, actor);
 }
 if(isAdmin)return {stores:storeRecords,products,stock,transfers,cash,sales,audit:relationalAudit,users,customers,suppliers,fiscalConfigs,fiscalDocuments,fiscalInutilizations,nfceConfigs};
 return {
  stores:storeRecords,products:products.map(p=>({...p,cost:0})),stock,transfers,
  cash:cash.filter(c=>c.storeId===actor.storeId).map(c=>c.closedAt?c:{...c,opening:0}),
  sales:sales.filter(s=>s.storeId===actor.storeId),
  audit:relationalAudit.filter(a=>a.storeId===actor.storeId),
  users,customers,suppliers,fiscalConfigs,fiscalDocuments,fiscalInutilizations,nfceConfigs,
 };
}
async function snapshot(row:Row,userId:string){const {actor,plan}=await context(row,userId);return {account:{name:row.name,subscription:plan},actor:{...actor,permissions:Array.from(actor.permissions)},state:await fullState(database(),row.id,actor),revision:row.revision}}
export async function GET(request:Request){
 try{
  const user=await getChatGPTUser();if(!user)return reply({error:'Entre para acessar sua conta.',signIn:true},401);
  const row=await account(user.userId);if(!row)return reply({setup:true,userName:user.displayName});
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
  const reportType=new URL(request.url).searchParams.get('report');
  if(reportType){
   const {actor}=await context(row,user.userId);
   const db=database();
   const params=new URL(request.url).searchParams;
   const storeId=params.get('storeId')||undefined;
   const from=params.get('from')?Number(params.get('from')):undefined;
   const to=params.get('to')?Number(params.get('to')):undefined;
   if(reportType==='sales')return reply(await getSalesReport(db,row.id,actor,{storeId,from,to}));
   if(reportType==='cash')return reply(await getCashReport(db,row.id,actor,{storeId}));
   if(reportType==='fiscal')return reply(await getFiscalReport(db,row.id,actor));
   if(reportType==='fiscal-jobs')return reply(await getFiscalJobsSummary(db,row.id,actor));
   return reply({error:'Relatório desconhecido.'},400);
  }
  return reply(await snapshot(row,user.userId));
 }catch(error){
  if(error instanceof RuleError)return reply({error:error.message},error.status);
  console.error('workspace.read failed',error);return reply({error:'Não foi possível carregar os dados. Tente novamente.'},503);
 }
}
export async function POST(request:Request){
 try{
  const origin=request.headers.get('origin');if(!origin||origin!==new URL(request.url).origin)return reply({error:'Origem da solicitação inválida.'},403);
  const user=await getChatGPTUser();if(!user)return reply({error:'Sessão encerrada. Entre novamente.',signIn:true},401);
  if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'Formato inválido.'},415);
  const raw=await request.text();if(raw.length>262144)return reply({error:'Solicitação muito grande.'},413);let body;try{body=JSON.parse(raw)}catch{return reply({error:'Solicitação inválida.'},400)}
  if(!body||typeof body!=='object')return reply({error:'Solicitação inválida.'},400);
  let row=await account(user.userId);
  if(body.type==='account.create'){
   if(row)return reply(await snapshot(row,user.userId));
   const name=typeof body.name==='string'?body.name.trim():'';if(name.length<2||name.length>100)return reply({error:'Informe o nome da conta (2 a 100 caracteres).'},400);
   const id=crypto.randomUUID(),now=Date.now(),db=database();
   const ownerRole=await db.prepare("SELECT id FROM roles WHERE name='OWNER' AND tenant_id IS NULL").first<{id:string}>();
   if(!ownerRole)throw new Error('Papel OWNER não encontrado. Execute as migrações de RBAC (Fase 1).');
   try{await db.batch([
    db.prepare('INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES (?,?,?,0,?,?,3,?)').bind(id,name,'{}','trial',now+7*24*60*60*1000,now),
    db.prepare('INSERT INTO memberships (user_id,account_id,role,store_id,display_name) VALUES (?,?,?,NULL,?)').bind(user.userId,id,'admin',user.displayName),
    db.prepare('INSERT INTO users (id,display_name,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name').bind(user.userId,user.displayName,now),
    db.prepare('INSERT INTO user_tenant_roles (id,user_id,tenant_id,role_id) VALUES (?,?,?,?)').bind(crypto.randomUUID(),user.userId,id,ownerRole.id),
   ])}catch(e){row=await account(user.userId);if(!row)throw e}
   row=await account(user.userId);if(!row)throw new Error('Account creation failed');return reply(await snapshot(row,user.userId),201);
  }
  if(!row)return reply({error:'Crie sua conta para continuar.'},403);
  if(typeof body.key!=='string'||!/^[a-f0-9-]{36}$/i.test(body.key))return reply({error:'Identificador de operação inválido.'},400);
  const db=database();const {actor,plan}=await context(row,user.userId);const now=Date.now();
  const parsed=commandSchema.safeParse(body.command);
  if(!parsed.success)return reply({error:'Confira os campos: '+parsed.error.issues.map(x=>x.message).join('; ')},400);
  const command=parsed.data;
  const fingerprint=JSON.stringify({actor:actor.userId,command});
  const ip=request.headers.get('cf-connecting-ip')||request.headers.get('x-forwarded-for');
  const {resultId}=await withIdempotency(db,row.id,body.key,fingerprint,()=>dispatchCommand(db,row!.id,actor,plan,command,now,{ip,correlationId:body.key}));
  await db.prepare('UPDATE accounts SET revision=revision+1 WHERE id=?').bind(row.id).run();
  row={...row,revision:row.revision+1};
  return reply({...(await snapshot(row,user.userId)),resultId});
 }catch(error){if(error instanceof RuleError)return reply({error:error.message},error.status);console.error('workspace.write failed',error);return reply({error:'Não foi possível salvar. Seus campos foram preservados; tente novamente.'},503)}
}