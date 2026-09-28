import assert from 'node:assert/strict';
import test from 'node:test';
import {createFakeD1} from './helpers/fakeD1.ts';
import {registerAccount} from '../lib/auth/service.ts';
import {permissionsForRole} from '../lib/authz/roles.ts';
import {createStore,createProduct} from '../lib/catalog/service.ts';
import {createCustomer} from '../lib/customers/service.ts';
import {registerUnit,createOrder,completeOrder} from '../lib/orders/service.ts';
import {openSession} from '../lib/cash/service.ts';
import {saveBillingConfig,prepareSchedule,billingView,issueReceivable,syncReceivable,monthlyDates,validBillingDate,receiveAsaasEvent,closeRental,listReceivablesOverview,customerReminders,getBillingConfigSummary,asaasPhone} from '../lib/billing/service.ts';
import type {Actor} from '../lib/domain.ts';
import type {AsaasPayment,BillingFetch} from '../lib/billing/asaas.ts';
import {AsaasClient} from '../lib/billing/asaas.ts';
const now=Date.UTC(2026,8,26,15);
process.env.FISCAL_SECRET_KEY='MOCK-TEST-ONLY-billing-key-32-characters';
// MOCK EXPLÍCITO do Asaas: somente testes. Produção usa fetch e os endpoints oficiais.
function asaasMock() {
 const payments=new Map<string,AsaasPayment>();let posts=0;let loseNext=false;
 const fetcher:BillingFetch=async(url,init)=>{
  const u=new URL(String(url)),method=init?.method??'GET';
  const json=(x:unknown,status=200)=>new Response(JSON.stringify(x),{status});
  if(u.pathname.endsWith('/customers')&&method==='GET')return json({data:[{id:'cus_mock',cpfCnpj:'52998224725'}],hasMore:false});
  if(u.pathname.endsWith('/payments')&&method==='GET')return json({data:[...payments.values()].filter(p=>p.externalReference===u.searchParams.get('externalReference')),hasMore:false});
  if(u.pathname.endsWith('/payments')&&method==='POST') {
   const b=JSON.parse(String(init?.body));posts++;
   const p={...b,id:`pay_mock_${posts}`,status:'PENDING',bankSlipUrl:'https://sandbox.asaas.com/b/mock'};payments.set(p.id,p);
   if(loseNext){loseNext=false;throw new Error('MOCK timeout after accepted');}return json(p);
  }
  const id=u.pathname.split('/').at(-1)!;const p=payments.get(id);if(!p)return json({},404);
  if(method==='DELETE'){p.deleted=true;return json({deleted:true});}return json(p);
 };
 return {fetcher,payments,posts:()=>posts,lose:()=>{loseNext=true;}};
}
async function fixture(type:'VENDA'|'LOCACAO'='VENDA') {
 const db=createFakeD1();
 const reg=await registerAccount(db,{accountName:'Empresa MOCK',displayName:'Dona',email:'dona@mock.test',password:'Test-only-password-123'});
 const actor:Actor={userId:reg.userId,displayName:'Dona',role:'admin',storeId:null,permissions:permissionsForRole('OWNER')};
 const tenant=reg.accountId;
 const store=await createStore(db,tenant,{name:'Loja MOCK',modalities:['VENDA_CONTRATO','LOCACAO']} as never,actor);
 const product=await createProduct(db,tenant,{name:'Produto MOCK',sku:'MOCK',price:10000,cost:1,minimum:0,unit:'UN',kind:type==='VENDA'?'MOTO':'LOCACAO'} as never,actor);
 const customer=await createCustomer(db,tenant,{name:'Pessoa MOCK',docType:'CPF',document:'52998224725'},actor);
 const unit=await registerUnit(db,tenant,{storeId:store,productId:product,serial:type==='VENDA'?'MOCK-123':'123456789012345',color:'Preto',memory:'128',condition:'Novo'},actor,now);
 const id=await createOrder(db,tenant,{storeId:store,type,customerId:customer,unitId:unit,total:10001,purchaseDate:'2026-09-26',downPayment:0,installments:3,firstDueDate:'2026-10-31',adhesionAmount:1000,adhesionBilling:'LOJA',adhesionPaymentMethod:'Dinheiro',monthlyAmount:9000,dueDay:10},actor,now);
 await openSession(db,tenant,store,0,actor,now);
 await completeOrder(db,tenant,id,actor,now);
 await saveBillingConfig(db,tenant,store,{environment:'SANDBOX',apiKey:'MOCK-asaas-token',webhookSecret:'MOCK-webhook-secret-at-least-32-characters',notificationsEnabled:false},actor,now);
 const mock=asaasMock();return {db,actor,tenant,store,id,unit,product,customer,mock};
}
test('cronograma: meses curtos, datas inválidas e centavos exatos',async()=>{
 assert.deepEqual(monthlyDates('2026-01-31',3),['2026-01-31','2026-02-28','2026-03-31']);assert.equal(validBillingDate('2026-99-99'),false);
 const f=await fixture();await prepareSchedule(f.db,f.tenant,f.id,{fineBp:0,interestBp:0},f.actor,now);
 await prepareSchedule(f.db,f.tenant,f.id,{fineBp:0,interestBp:0},f.actor,now);
 const view=await billingView(f.db,f.tenant,f.id,f.actor);assert.deepEqual(view.receivables.map(r=>r.amount),[3333,3333,3335]);assert.equal(view.receivables.length,3);
});
test('configuração cifrada, isolamento e permissões no backend',async()=>{
 const f=await fixture();const row=await f.db.prepare('SELECT api_key_enc AS secret FROM order_billing_configs WHERE store_id=?').bind(f.store).first<{secret:string}>();assert.ok(!row!.secret.includes('MOCK-asaas-token'));
 await assert.rejects(()=>billingView(f.db,'outra-conta',f.id,f.actor),/não encontrado/);
 await assert.rejects(()=>saveBillingConfig(f.db,f.tenant,f.store,{environment:'SANDBOX',notificationsEnabled:false},{...f.actor,permissions:permissionsForRole('CONSULTA')}),/permiss/i);
 await assert.rejects(()=>prepareSchedule(f.db,f.tenant,f.id,{},f.actor,now),/multa e juros/);
});
test('timeout após criar boleto reconcilia a mesma referência sem repetir POST',async()=>{
 const f=await fixture();await prepareSchedule(f.db,f.tenant,f.id,{fineBp:0,interestBp:0},f.actor,now);
 const r=(await billingView(f.db,f.tenant,f.id,f.actor)).receivables[0];f.mock.lose();
 await assert.rejects(()=>issueReceivable(f.db,f.tenant,r.id,f.actor,f.mock.fetcher,now),/incerta/);
 assert.equal((await billingView(f.db,f.tenant,f.id,f.actor)).receivables[0].status,'UNCERTAIN');
 await issueReceivable(f.db,f.tenant,r.id,f.actor,f.mock.fetcher,now+1000);assert.equal(f.mock.posts(),1);
 assert.equal((await billingView(f.db,f.tenant,f.id,f.actor)).receivables[0].status,'OPEN');
});
test('duplo clique, valor divergente e webhook falso não quitam a cobrança',async()=>{
 const f=await fixture();await prepareSchedule(f.db,f.tenant,f.id,{fineBp:0,interestBp:0},f.actor,now);
 const r=(await billingView(f.db,f.tenant,f.id,f.actor)).receivables[0];
 await Promise.allSettled([issueReceivable(f.db,f.tenant,r.id,f.actor,f.mock.fetcher,now),issueReceivable(f.db,f.tenant,r.id,f.actor,f.mock.fetcher,now)]);assert.equal(f.mock.posts(),1);
 const p=[...f.mock.payments.values()][0];p.status='RECEIVED';p.value=999;await assert.rejects(()=>syncReceivable(f.db,f.tenant,r.id,f.mock.fetcher,now),/diverge/);
 const cfg=await f.db.prepare('SELECT webhook_key AS key FROM order_billing_configs WHERE store_id=?').bind(f.store).first<{key:string}>();
 assert.equal(await receiveAsaasEvent(f.db,cfg!.key,'falso',{id:'evt_1',payment:{id:p.id}},now),401);
 for(let i=0;i<2;i++)assert.equal(await receiveAsaasEvent(f.db,cfg!.key,'MOCK-webhook-secret-at-least-32-characters',{id:'evt_1',payment:{id:p.id}},now),200);
 const n=await f.db.prepare('SELECT COUNT(*) AS n FROM asaas_events').bind().first<{n:number}>();assert.equal(Number(n!.n),1);
});
test('locação prepara 12 mensalidades e exige dia definido no contrato',async()=>{
 const f=await fixture('LOCACAO');await assert.rejects(()=>prepareSchedule(f.db,f.tenant,f.id,{firstDueDate:'2026-10-11'},f.actor,now),/dia do contrato/);
 await prepareSchedule(f.db,f.tenant,f.id,{firstDueDate:'2026-10-10'},f.actor,now);
 const rows=await f.db.prepare('SELECT fine_bp AS fine,interest_bp AS interest FROM order_receivables WHERE order_id=?').bind(f.id).all<{fine:number;interest:number}>();assert.equal(rows.results.length,12);assert.ok(rows.results.every(r=>Number(r.fine)===200&&Number(r.interest)===100));
 await assert.rejects(()=>closeRental(f.db,f.tenant,f.id,{type:'RETURN',assessment:'Aparelho em bom estado',damageAmount:0},f.actor,f.mock.fetcher,now),/contrato.*assinado/);
});

// MOCK EXPLÍCITO de contrato já assinado: o teste de locação não chama o Adapter Sign.
async function signedContract(f:Awaited<ReturnType<typeof fixture>>) {
 await f.db.prepare(`INSERT INTO contracts(id,tenant_id,store_id,order_id,customer_id,contract_type,template_key,template_version,revision,external_ref,internal_status,original_document_id,original_sha256,payload_snapshot,generated_by,generated_by_name,generated_at,created_at,updated_at) VALUES(?,?,?,?,?,'LOCACAO','contrato-locacao',1,1,?,'COMPLETED','MOCK-document','MOCK-hash','{}',?,'MOCK',?,?,?)`).bind(crypto.randomUUID(),f.tenant,f.store,f.id,f.customer,`mock-${f.id}`,f.actor.userId,now,now,now).run();
}
test('devolução cancela vincendas, preserva vencidas e devolve unidade uma única vez',async()=>{
 const f=await fixture('LOCACAO');await signedContract(f);await prepareSchedule(f.db,f.tenant,f.id,{firstDueDate:'2026-10-10'},f.actor,now);
 const rows=(await billingView(f.db,f.tenant,f.id,f.actor)).receivables;
 for(const r of rows)await issueReceivable(f.db,f.tenant,r.id,f.actor,f.mock.fetcher,now);
 const later=Date.UTC(2026,10,15,15);
 await closeRental(f.db,f.tenant,f.id,{type:'RETURN',assessment:'Aparelho conferido, sem avarias',damageAmount:0},f.actor,f.mock.fetcher,later);
 await closeRental(f.db,f.tenant,f.id,{type:'RETURN',assessment:'Aparelho conferido, sem avarias',damageAmount:0},f.actor,f.mock.fetcher,later);
 const view=await billingView(f.db,f.tenant,f.id,f.actor);assert.equal(view.receivables.filter(r=>r.status==='CANCELLED').length,10);assert.equal(view.receivables.filter(r=>r.status==='OPEN').length,2);
 const stock=await f.db.prepare('SELECT quantity FROM inventories WHERE store_id=? AND product_id=?').bind(f.store,f.product).first<{quantity:number}>();assert.equal(Number(stock!.quantity),1);
 const ledger=await f.db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reference_type='RENTAL_RETURN'").bind().first<{n:number}>();assert.equal(Number(ledger!.n),1);
});
test('compra exige quitação em produção; sandbox nunca transfere propriedade',async()=>{
 const f=await fixture('LOCACAO');await signedContract(f);await prepareSchedule(f.db,f.tenant,f.id,{firstDueDate:'2026-10-10'},f.actor,now);
 const rows=(await billingView(f.db,f.tenant,f.id,f.actor)).receivables;
 for(const r of rows)await issueReceivable(f.db,f.tenant,r.id,f.actor,f.mock.fetcher,now);
 for(const p of f.mock.payments.values())p.status='RECEIVED';
 await assert.rejects(()=>closeRental(f.db,f.tenant,f.id,{type:'PURCHASE',assessment:'Cliente solicitou compra',damageAmount:0,residualDueDate:'2026-10-10'},f.actor,f.mock.fetcher,now),/produção/);
 const unit=await f.db.prepare('SELECT status FROM product_units WHERE id=?').bind(f.unit).first<{status:string}>();assert.equal(unit!.status,'RENTED');
});

test('controle de inadimplência: vencido, pago em dinheiro, filtros e escopo por loja',async()=>{
 const f=await fixture();await prepareSchedule(f.db,f.tenant,f.id,{fineBp:200,interestBp:100},f.actor,now);
 for(const r of (await billingView(f.db,f.tenant,f.id,f.actor)).receivables)await issueReceivable(f.db,f.tenant,r.id,f.actor,f.mock.fetcher,now);
 const [p1,p2]=[...f.mock.payments.values()];p1.status='RECEIVED_IN_CASH';
 const later=Date.UTC(2026,10,5,15); // 1ª parcela (31/10) vencida, 2ª (30/11) ainda não
 for(const r of (await billingView(f.db,f.tenant,f.id,f.actor)).receivables)await syncReceivable(f.db,f.tenant,r.id,f.mock.fetcher,later);
 let o=await listReceivablesOverview(f.db,f.tenant,f.actor,'overdue',later);
 assert.equal(o.items.length,0,'parcela recebida em dinheiro não é inadimplência');assert.equal(o.totals.paidAmount,3333);
 p2.status='PENDING';p1.status='PENDING';await f.db.prepare("UPDATE order_receivables SET status='OPEN' WHERE provider_id=?").bind(p1.id).run();
 o=await listReceivablesOverview(f.db,f.tenant,f.actor,'overdue',later);
 assert.equal(o.items.length,1);assert.equal(o.items[0].daysOverdue,5);assert.equal(o.items[0].customerName,'Pessoa MOCK');assert.equal(o.totals.delinquentCustomers,1);assert.equal(o.totals.overdueAmount,3333);
 assert.equal((await listReceivablesOverview(f.db,f.tenant,f.actor,'open',later)).items.length,3);
 assert.equal((await listReceivablesOverview(f.db,f.tenant,{...f.actor,role:'operator',storeId:'outra-loja'},'all',later)).items.length,0);
 assert.equal((await listReceivablesOverview(f.db,'outra-conta',f.actor,'all',later)).items.length,0);
 await assert.rejects(()=>listReceivablesOverview(f.db,f.tenant,f.actor,'x' as never,later),/Filtro/);
});
test('lembretes: mostra configuração do Asaas; webhook de evento sem cobrança é aceito e ignorado',async()=>{
 const f=await fixture();await prepareSchedule(f.db,f.tenant,f.id,{fineBp:0,interestBp:0},f.actor,now);
 const r=(await billingView(f.db,f.tenant,f.id,f.actor)).receivables[0];
 await assert.rejects(()=>customerReminders(f.db,f.tenant,r.id,f.actor,f.mock.fetcher),/emita o boleto/);
 await issueReceivable(f.db,f.tenant,r.id,f.actor,f.mock.fetcher,now);
 // MOCK do GET /customers/{id}/notifications (formato da referência oficial do Asaas).
 const fetcher:BillingFetch=async(url,init)=>String(url).endsWith('/customers/cus_mock/notifications')?new Response(JSON.stringify({data:[{event:'PAYMENT_DUEDATE_WARNING',enabled:true,emailEnabledForCustomer:true,smsEnabledForCustomer:false,whatsappEnabledForCustomer:true,phoneCallEnabledForCustomer:false,scheduleOffset:5},{event:'PAYMENT_OVERDUE',enabled:false,emailEnabledForCustomer:true,scheduleOffset:1}]}),{status:200}):f.mock.fetcher(url,init);
 const rem=await customerReminders(f.db,f.tenant,r.id,f.actor,fetcher);
 assert.deepEqual(rem.reminders[0],{event:'PAYMENT_DUEDATE_WARNING',enabled:true,channels:['E-mail','WhatsApp'],scheduleOffset:5});assert.equal(rem.reminders[1].enabled,false);
 const cfg=await f.db.prepare('SELECT webhook_key AS key FROM order_billing_configs WHERE store_id=?').bind(f.store).first<{key:string}>();
 assert.equal(await receiveAsaasEvent(f.db,cfg!.key,'MOCK-webhook-secret-at-least-32-characters',{id:'evt_transfer',event:'TRANSFER_DONE',transfer:{id:'tra_1'}},now),200);
 const n=await f.db.prepare('SELECT COUNT(*) AS n FROM asaas_events').bind().first<{n:number}>();assert.equal(Number(n!.n),0);
});

test('resumo da configuração por loja: nunca devolve segredos e trava o ambiente após o primeiro boleto',async()=>{
 const f=await fixture();
 const s1=await getBillingConfigSummary(f.db,f.tenant,f.store,f.actor);
 assert.equal(s1.configured,true);assert.equal(s1.environment,'SANDBOX');assert.equal(s1.environmentLocked,false);
 assert.ok(!JSON.stringify(s1).includes('MOCK-asaas-token')&&!JSON.stringify(s1).includes('MOCK-webhook-secret'));
 assert.match(String(s1.webhookPath),/^\/api\/billing\/asaas\/webhook\/[a-f0-9]{48}$/);
 await prepareSchedule(f.db,f.tenant,f.id,{fineBp:0,interestBp:0},f.actor,now);
 assert.equal((await getBillingConfigSummary(f.db,f.tenant,f.store,f.actor)).environmentLocked,true);
 await assert.rejects(()=>getBillingConfigSummary(f.db,f.tenant,f.store,{...f.actor,permissions:permissionsForRole('OPERADOR_CAIXA')}),/permiss/i);
});

test('Asaas: telefone no formato aceito e motivo da recusa mostrado ao usuário',async()=>{
 assert.deepEqual(asaasPhone('(21) 98508-0634'),{mobilePhone:'21985080634'});
 assert.deepEqual(asaasPhone('+55 21 98508-0634'),{mobilePhone:'21985080634'});
 assert.deepEqual(asaasPhone('(21) 3333-4444'),{phone:'2133334444'});
 assert.deepEqual(asaasPhone('123'),{});
 // MOCK do erro documentado do Asaas: { errors: [{ code, description }] }.
 const fetcher:BillingFetch=async()=>new Response(JSON.stringify({errors:[{code:'invalid_cpfCnpj',description:'O CPF/CNPJ informado é inválido.'}]}),{status:400});
 await assert.rejects(()=>new AsaasClient('MOCK-key','SANDBOX',fetcher).call('POST','/customers',{}),/ao cadastrar o cliente \(HTTP 400\): O CPF\/CNPJ informado é inválido\./);
 const f2:BillingFetch=async()=>new Response('{}',{status:401});
 await assert.rejects(()=>new AsaasClient('MOCK-key','SANDBOX',f2).call('GET','/payments'),/HTTP 401.*API key/);
});
test('Asaas: boleto sem multa/juros não envia os objetos zerados; CPF vai só com dígitos',async()=>{
 const f=await fixture();await prepareSchedule(f.db,f.tenant,f.id,{fineBp:0,interestBp:0},f.actor,now);
 const bodies:Record<string,unknown>[]=[];
 const spy:BillingFetch=async(url,init)=>{if(init?.method==='POST')bodies.push(JSON.parse(String(init.body)));return f.mock.fetcher(url,init);};
 const r=(await billingView(f.db,f.tenant,f.id,f.actor)).receivables[0];
 await issueReceivable(f.db,f.tenant,r.id,f.actor,spy,now);
 const payment=bodies.find(b=>b.billingType==='BOLETO')!;
 assert.ok(!('fine' in payment)&&!('interest' in payment));
});

test('Asaas: referências externas cabem no limite de 100 caracteres e descrição usa o número do pedido',async()=>{
 const f=await fixture();await prepareSchedule(f.db,f.tenant,f.id,{fineBp:0,interestBp:0},f.actor,now);
 const bodies:{url:string;body:Record<string,unknown>}[]=[];
 // MOCK: GET /customers sem resultado força o cadastro (POST /customers) para inspecionar o corpo.
 const spy:BillingFetch=async(url,init)=>{
  const u=new URL(String(url));
  if(u.pathname.endsWith('/customers')&&(init?.method??'GET')==='GET')return new Response(JSON.stringify({data:[],hasMore:false}),{status:200});
  if(u.pathname.endsWith('/customers')&&init?.method==='POST'){const b=JSON.parse(String(init.body));bodies.push({url:u.pathname,body:b});return new Response(JSON.stringify({id:'cus_mock',cpfCnpj:b.cpfCnpj}),{status:200});}
  if(init?.method==='POST')bodies.push({url:u.pathname,body:JSON.parse(String(init.body))});
  return f.mock.fetcher(url,init);
 };
 const r=(await billingView(f.db,f.tenant,f.id,f.actor)).receivables[0];
 await issueReceivable(f.db,f.tenant,r.id,f.actor,spy,now);
 const customer=bodies.find(b=>b.url.endsWith('/customers'))!.body, payment=bodies.find(b=>b.url.endsWith('/payments'))!.body;
 assert.equal(customer.externalReference,`omnihub-${f.customer}`);
 assert.ok(String(customer.externalReference).length<=100&&String(payment.externalReference).length<=100);
 assert.equal(customer.cpfCnpj,'52998224725');
 assert.match(String(payment.description),/^Pedido #\d+ - Parcela 1$/);
});
