import { z } from 'zod';
export const money = (cents:number)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(cents/100);
export const date = (value:number)=>new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'});
export type StoreRecord={id:string;name:string;legalName:string;cnpj:string;ie:string;regime:string;uf:string;city:string;municipalityCode:string;address:string;number:string;district:string;zip:string};
export type Product={id:string;name:string;sku:string;barcode:string;price:number;cost:number;minimum:number;ncm:string;cest:string;cfop:string;origin:string;taxCode:string;unit:string};
export type Cash={id:string;storeId:string;userId:string;operator:string;openedAt:number;opening:number;closedAt?:number;counted?:number;expected?:number;difference?:number};
export type Sale={id:string;storeId:string;storeName:string;storeCnpj:string;cashId:string;userId:string;operator:string;createdAt:number;items:{productId:string;name:string;sku:string;qty:number;price:number}[];total:number;payment:'Dinheiro'|'Pix'|'Cartão';customer:string;document:string;fiscalStatus:'pending';printCount:number};
export type Transfer={id:string;from:string;to:string;productId:string;productName:string;qty:number;status:'transit'|'received';createdAt:number;receivedAt?:number;operator:string};
export type Audit={id:string;at:number;userId:string;operator:string;action:string;description:string;storeId?:string};
export type State={stores:StoreRecord[];products:Product[];stock:Record<string,Record<string,number>>;cash:Cash[];sales:Sale[];transfers:Transfer[];audit:Audit[];requests:Record<string,{fingerprint:string;resultId?:string}>};
export type Actor={userId:string;displayName:string;role:string;storeId:string|null};
export type Entitlement={status:string;accessUntil:number;maxStores:number};
export type Snapshot={account:{name:string;subscription:Entitlement};actor:Actor;state:State;revision:number};
export function emptyState():State{return {stores:[],products:[],stock:{},cash:[],sales:[],transfers:[],audit:[],requests:{}}}
const short=z.string().trim().max(160); const cents=z.number().int().min(0).max(100000000); const qty=z.number().int().min(1).max(1000000); const identifier=z.string().min(1).max(80);
export const storeFields=z.object({name:short.min(2),legalName:short.default(''),cnpj:z.string().regex(/^(\d{14})?$/,'CNPJ deve ter 14 dígitos.').default(''),ie:short.default(''),regime:z.enum(['','Simples Nacional','Lucro Presumido','Lucro Real']).default(''),uf:z.string().regex(/^([A-Z]{2})?$/).default(''),city:short.default(''),municipalityCode:z.string().regex(/^(\d{7})?$/).default(''),address:short.default(''),number:short.default(''),district:short.default(''),zip:z.string().regex(/^(\d{8})?$/).default('')}).strict();
export const productFields=z.object({name:short.min(2),sku:short.min(1),barcode:short.default(''),price:cents,cost:cents,minimum:z.number().int().min(0).max(100000),ncm:z.string().regex(/^(\d{8})?$/).default(''),cest:z.string().regex(/^(\d{7})?$/).default(''),cfop:z.string().regex(/^(\d{4})?$/).default(''),origin:z.string().regex(/^[0-8]?$/).default(''),taxCode:z.string().regex(/^(\d{2,3})?$/).default(''),unit:z.string().trim().min(1).max(6)}).strict();
export const commandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('store.create'),data:storeFields}),z.object({type:z.literal('store.update'),id:identifier,data:storeFields}),
 z.object({type:z.literal('product.create'),data:productFields}),z.object({type:z.literal('product.update'),id:identifier,data:productFields}),
 z.object({type:z.literal('stock.receive'),storeId:identifier,productId:identifier,qty,reason:short.min(3)}),
 z.object({type:z.literal('transfer.create'),from:identifier,to:identifier,productId:identifier,qty}),
 z.object({type:z.literal('transfer.receive'),id:identifier}),
 z.object({type:z.literal('cash.open'),storeId:identifier,opening:cents}),z.object({type:z.literal('cash.close'),id:identifier,counted:cents}),
 z.object({type:z.literal('sale.create'),storeId:identifier,items:z.array(z.object({productId:identifier,qty})).min(1).max(100),payment:z.enum(['Dinheiro','Pix','Cartão']),customer:short,document:z.string().regex(/^(\d{11}|\d{14})?$/)}),
 z.object({type:z.literal('sale.print'),id:identifier}),
]);
export type Command=z.infer<typeof commandSchema>;
export class RuleError extends Error{status:number;constructor(message:string,status=400){super(message);this.status=status}}
export function requireActive(plan:Entitlement,now:number){if(!['active','trial'].includes(plan.status)||plan.accessUntil<=now)throw new RuleError('Seu período de acesso terminou. Novas operações estão bloqueadas.',402)}
export function execute(state:State,actor:Actor,plan:Entitlement,raw:unknown,key:string,now=Date.now()):{state:State;resultId?:string;replayed:boolean}{
 const parsed=commandSchema.safeParse(raw);if(!parsed.success)throw new RuleError('Confira os campos: '+parsed.error.issues.map(x=>x.message).join('; ')); const c=parsed.data;
 const fingerprint=JSON.stringify({actor:actor.userId,command:c}); const previous=state.requests[key];
 if(previous){if(previous.fingerprint!==fingerprint)throw new RuleError('Identificador de operação já utilizado.',409);return {state,resultId:previous.resultId,replayed:true}}
 if(c.type!=='sale.print'&&c.type!=='cash.close'&&c.type!=='transfer.receive')requireActive(plan,now);
 const next=structuredClone(state);let resultId:string|undefined;let description='';let auditStore:string|undefined;
 const admin=()=>{if(actor.role!=='admin')throw new RuleError('Somente o administrador pode realizar esta operação.',403)};
 const store=(id:string,write=true)=>{const s=next.stores.find(s=>s.id===id);if(!s)throw new RuleError('Loja não encontrada.',404);if(write&&actor.role!=='admin'&&actor.storeId!==id)throw new RuleError('Você não pode movimentar outra loja.',403);return s};
 const product=(id:string)=>{const p=next.products.find(p=>p.id===id);if(!p)throw new RuleError('Produto não encontrado.',404);return p};
 const stock=(s:string,p:string)=>next.stock[s]?.[p]??0;
 const move=(s:string,p:string,delta:number)=>{const balance=stock(s,p)+delta;if(balance<0)throw new RuleError('Estoque insuficiente para esta operação.',409);next.stock[s]??={};next.stock[s][p]=balance};
 if(c.type==='store.create'||c.type==='store.update'){
  admin();if(c.type==='store.create'){if(next.stores.length>=plan.maxStores)throw new RuleError('Limite de lojas do plano atingido.',403);resultId=crypto.randomUUID();next.stores.push({id:resultId,...c.data});next.stock[resultId]={}}else{store(c.id);next.stores=next.stores.map(s=>s.id===c.id?{id:c.id,...c.data}:s);resultId=c.id}description=`Loja: ${c.data.name}`;auditStore=resultId;
 }else if(c.type==='product.create'||c.type==='product.update'){
  admin();const id=c.type==='product.update'?c.id:crypto.randomUUID();if(c.type==='product.update')product(id);if(next.products.some(p=>p.sku===c.data.sku&&p.id!==id))throw new RuleError('Já existe um produto com este SKU.',409);if(c.type==='product.create')next.products.push({id,...c.data});else next.products=next.products.map(p=>p.id===id?{id,...c.data}:p);resultId=id;description=`Produto: ${c.data.name}`;
 }else if(c.type==='stock.receive'){
  admin();const s=store(c.storeId),p=product(c.productId);move(s.id,p.id,c.qty);description=`Entrada de ${c.qty} × ${p.name} em ${s.name}: ${c.reason}`;auditStore=s.id;
 }else if(c.type==='transfer.create'){
  admin();const from=store(c.from),to=store(c.to),p=product(c.productId);if(from.id===to.id)throw new RuleError('Escolha lojas diferentes.');move(from.id,p.id,-c.qty);resultId=crypto.randomUUID();next.transfers.unshift({id:resultId,from:from.id,to:to.id,productId:p.id,productName:p.name,qty:c.qty,status:'transit',createdAt:now,operator:actor.displayName});description=`${c.qty} × ${p.name}: ${from.name} → ${to.name}`;auditStore=from.id;
 }else if(c.type==='transfer.receive'){
  admin();const t=next.transfers.find(t=>t.id===c.id);if(!t)throw new RuleError('Transferência não encontrada.',404);if(t.status!=='transit')throw new RuleError('Transferência já recebida.',409);store(t.to);move(t.to,t.productId,t.qty);t.status='received';t.receivedAt=now;resultId=t.id;description=`Recebimento de ${t.qty} × ${t.productName}`;auditStore=t.to;
 }else if(c.type==='cash.open'){
  const s=store(c.storeId);if(next.cash.some(x=>x.storeId===s.id&&x.userId===actor.userId&&!x.closedAt))throw new RuleError('Você já tem um caixa aberto nesta loja.',409);resultId=crypto.randomUUID();next.cash.unshift({id:resultId,storeId:s.id,userId:actor.userId,operator:actor.displayName,openedAt:now,opening:c.opening});description=`Abertura de caixa em ${s.name}`;auditStore=s.id;
 }else if(c.type==='cash.close'){
  const cash=next.cash.find(x=>x.id===c.id);if(!cash)throw new RuleError('Caixa não encontrado.',404);store(cash.storeId);if(actor.role!=='admin'&&cash.userId!==actor.userId)throw new RuleError('Você só pode fechar seu próprio caixa.',403);if(cash.closedAt)throw new RuleError('Caixa já fechado.',409);const expected=cash.opening+next.sales.filter(s=>s.cashId===cash.id&&s.payment==='Dinheiro').reduce((a,s)=>a+s.total,0);Object.assign(cash,{closedAt:now,counted:c.counted,expected,difference:c.counted-expected});description=`Fechamento de caixa; diferença: ${money(c.counted-expected)}`;auditStore=cash.storeId;resultId=cash.id;
 }else if(c.type==='sale.create'){
  const s=store(c.storeId),cash=next.cash.find(x=>x.storeId===s.id&&x.userId===actor.userId&&!x.closedAt);if(!cash)throw new RuleError('Abra seu caixa nesta loja antes de vender.',409);const ids=new Set(c.items.map(x=>x.productId));if(ids.size!==c.items.length)throw new RuleError('Produtos repetidos no carrinho.');const items=c.items.map(item=>{const p=product(item.productId);move(s.id,p.id,-item.qty);return {productId:p.id,name:p.name,sku:p.sku,qty:item.qty,price:p.price}});const total=items.reduce((a,i)=>a+i.price*i.qty,0);if(!Number.isSafeInteger(total)||total>100000000)throw new RuleError('Valor da venda excede o limite.');resultId=crypto.randomUUID();next.sales.unshift({id:resultId,storeId:s.id,storeName:s.name,storeCnpj:s.cnpj,cashId:cash.id,userId:actor.userId,operator:actor.displayName,createdAt:now,items,total,payment:c.payment,customer:c.customer,document:c.document,fiscalStatus:'pending',printCount:0});description=`Venda ${resultId.slice(0,8)} · ${money(total)} · ${c.payment}`;auditStore=s.id;
 }else if(c.type==='sale.print'){
  const sale=next.sales.find(s=>s.id===c.id);if(!sale)throw new RuleError('Venda não encontrada.',404);store(sale.storeId);sale.printCount++;resultId=sale.id;description=`Impressão solicitada: ${sale.id.slice(0,8)}`;auditStore=sale.storeId;
 }
 next.audit.unshift({id:crypto.randomUUID(),at:now,userId:actor.userId,operator:actor.displayName,action:c.type,description,storeId:auditStore});next.requests[key]={fingerprint,resultId};return {state:next,resultId,replayed:false};
}
export function visibleState(state:State,actor:Actor):State{
 const data=structuredClone(state);data.requests={};if(actor.role==='admin')return data;
 data.sales=data.sales.filter(s=>s.storeId===actor.storeId);data.cash=data.cash.filter(c=>c.storeId===actor.storeId).map(c=>{if(!c.closedAt)return {...c,opening:0};return c});data.audit=data.audit.filter(a=>a.storeId===actor.storeId);data.products=data.products.map(p=>({...p,cost:0}));return data;
}

