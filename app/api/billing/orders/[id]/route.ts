import { isSameOrigin } from '@/app/auth';
import { database } from '@/db/database';
import { resolveWorkspaceSession } from '@/lib/http/workspaceSession';
import { RuleError, requireActive } from '@/lib/domain';
import { billingView, saveBillingConfig, prepareSchedule, issueReceivable, syncReceivable, closeRental } from '@/lib/billing/service';
import { logger } from '@/lib/log';
export const dynamic='force-dynamic';
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
async function handle(request:Request,context:{params:Promise<{id:string}>},mutate:boolean) {
 try {
  if(mutate&&!isSameOrigin(request))return reply({error:'Origem inválida.'},403);
  const session=await resolveWorkspaceSession();if(!session)return reply({error:'Entre na sua conta.'},401);
  const {tenantId,actor,plan}=session,db=database(),{id}=await context.params;
  const view=await billingView(db,tenantId,id,actor);
  if(!mutate)return reply(view);
  if(Number(request.headers.get('content-length'))>10000)return reply({error:'Requisição muito grande.'},413);
  const text=await request.text();if(text.length>10000)return reply({error:'Requisição muito grande.'},413);
  const body=JSON.parse(text);
  if(body.action!=='refresh')requireActive(plan,Date.now());
  if(body.action==='configure') {
   const order=await db.prepare('SELECT store_id AS storeId FROM orders WHERE id=? AND tenant_id=?').bind(id,tenantId).first<{storeId:string}>();
   await saveBillingConfig(db,tenantId,order!.storeId,body,actor);
  }else if(body.action==='prepare')await prepareSchedule(db,tenantId,id,body,actor);
  else if(body.action==='issue'||body.action==='refresh') {
   if(!view.receivables.some(r=>r.id===body.receivableId))throw new RuleError('Cobrança não encontrada neste pedido.',404);
   if(body.action==='issue')await issueReceivable(db,tenantId,body.receivableId,actor);
   else await syncReceivable(db,tenantId,body.receivableId);
  }else if(body.action==='closeRental')await closeRental(db,tenantId,id,body,actor);
  else throw new RuleError('Ação inválida.',400);
  return reply(await billingView(db,tenantId,id,actor));
 }catch(error){
  if(error instanceof RuleError)return reply({error:error.message},error.status);
  if(error instanceof SyntaxError)return reply({error:'Dados inválidos.'},400);
  logger.error('billing.erro',{error});return reply({error:'Não foi possível concluir. Consulte a situação antes de repetir.'},500);
 }
}
export const GET=(r:Request,c:{params:Promise<{id:string}>})=>handle(r,c,false);
export const POST=(r:Request,c:{params:Promise<{id:string}>})=>handle(r,c,true);
