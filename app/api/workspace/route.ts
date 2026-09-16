import { getChatGPTUser } from '@/app/chatgpt-auth';
import { database } from '@/db/database';
import { emptyState, execute, RuleError, visibleState, type State, type Actor } from '@/lib/domain';
import { loadPermissions } from '@/lib/authz/service';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers});
type Row={id:string;name:string;state:string;revision:number;subscription_status:string;access_until:number;max_stores:number;role:string;store_id:string|null;display_name:string};
async function account(userId:string){return database().prepare('SELECT a.*, m.role, m.store_id, m.display_name FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=?').bind(userId).first<Row>()}
async function context(row:Row,userId:string){const permissions=await loadPermissions(database(),userId,row.id,row.role);return {actor:{userId,role:row.role,storeId:row.store_id,displayName:row.display_name,permissions} satisfies Actor,plan:{status:row.subscription_status,accessUntil:row.access_until,maxStores:row.max_stores}}}
async function snapshot(row:Row,userId:string){const {actor,plan}=await context(row,userId);return {account:{name:row.name,subscription:plan},actor:{...actor,permissions:Array.from(actor.permissions)},state:visibleState(JSON.parse(row.state) as State,actor),revision:row.revision}}
export async function GET(){try{const user=await getChatGPTUser();if(!user)return reply({error:'Entre para acessar sua conta.',signIn:true},401);const row=await account(user.userId);if(!row)return reply({setup:true,userName:user.displayName});return reply(await snapshot(row,user.userId))}catch(error){console.error('workspace.read failed',error);return reply({error:'Não foi possível carregar os dados. Tente novamente.'},503)}}
export async function POST(request:Request){
 try{
  const origin=request.headers.get('origin');if(!origin||origin!==new URL(request.url).origin)return reply({error:'Origem da solicitação inválida.'},403);
  const user=await getChatGPTUser();if(!user)return reply({error:'Sessão encerrada. Entre novamente.',signIn:true},401);
  if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'Formato inválido.'},415);
  const raw=await request.text();if(raw.length>64000)return reply({error:'Solicitação muito grande.'},413);let body;try{body=JSON.parse(raw)}catch{return reply({error:'Solicitação inválida.'},400)}
  if(!body||typeof body!=='object')return reply({error:'Solicitação inválida.'},400);
  let row=await account(user.userId);
  if(body.type==='account.create'){
   if(row)return reply(await snapshot(row,user.userId));
   const name=typeof body.name==='string'?body.name.trim():'';if(name.length<2||name.length>100)return reply({error:'Informe o nome da conta (2 a 100 caracteres).'},400);
   const id=crypto.randomUUID(),now=Date.now(),db=database();
   const ownerRole=await db.prepare("SELECT id FROM roles WHERE name='OWNER' AND tenant_id IS NULL").first<{id:string}>();
   if(!ownerRole)throw new Error('Papel OWNER não encontrado. Execute as migrações de RBAC (Fase 1).');
   try{await db.batch([
    db.prepare('INSERT INTO accounts (id,name,state,revision,subscription_status,access_until,max_stores,created_at) VALUES (?,?,?,0,?,?,3,?)').bind(id,name,JSON.stringify(emptyState()),'trial',now+7*24*60*60*1000,now),
    db.prepare('INSERT INTO memberships (user_id,account_id,role,store_id,display_name) VALUES (?,?,?,NULL,?)').bind(user.userId,id,'admin',user.displayName),
    db.prepare('INSERT INTO users (id,display_name,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name').bind(user.userId,user.displayName,now),
    db.prepare('INSERT INTO user_tenant_roles (id,user_id,tenant_id,role_id) VALUES (?,?,?,?)').bind(crypto.randomUUID(),user.userId,id,ownerRole.id),
   ])}catch(e){row=await account(user.userId);if(!row)throw e}
   row=await account(user.userId);if(!row)throw new Error('Account creation failed');return reply(await snapshot(row,user.userId),201);
  }
  if(!row)return reply({error:'Crie sua conta para continuar.'},403);
  if(typeof body.key!=='string'||!/^[a-f0-9-]{36}$/i.test(body.key))return reply({error:'Identificador de operação inválido.'},400);
  const {actor,plan}=await context(row,user.userId);const result=execute(JSON.parse(row.state),actor,plan,body.command,body.key);
  if(result.replayed)return reply({...(await snapshot(row,user.userId)),resultId:result.resultId});
  if(body.revision!==row.revision)return reply({error:'Os dados mudaram em outra sessão. Atualize e confira antes de tentar novamente.'},409);
  const saved=await database().prepare('UPDATE accounts SET state=?, revision=revision+1 WHERE id=? AND revision=? AND subscription_status=? AND access_until=? AND max_stores=?').bind(JSON.stringify(result.state),row.id,row.revision,row.subscription_status,row.access_until,row.max_stores).run();
  if(saved.meta.changes!==1)return reply({error:'Outra operação foi concluída primeiro. Atualize e tente novamente.'},409);
  row={...row,state:JSON.stringify(result.state),revision:row.revision+1};return reply({...(await snapshot(row,user.userId)),resultId:result.resultId});
 }catch(error){if(error instanceof RuleError)return reply({error:error.message},error.status);console.error('workspace.write failed',error);return reply({error:'Não foi possível salvar. Seus campos foram preservados; tente novamente.'},503)}
}
