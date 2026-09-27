'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {money,type OrderView} from '@/lib/domain';
type View={config:{environment:string;notificationsEnabled:boolean;webhookPath:string|null}|null;receivables:{id:string;kind:string;sequence:number;amount:number;dueDate:string;status:string;providerStatus:string;url:string;error:string;environment:string}[];closure:{type:string;status:string;assessment:string;damageAmount:number}|null};
const labels:Record<string,string>={DRAFT:'Preparado',CREATING:'Enviando',UNCERTAIN:'Conferir no Asaas',OPEN:'Aguardando pagamento',OVERDUE:'Vencido',PAID:'Pago',CANCELLED:'Cancelado',REFUNDED:'Estornado',REVIEW:'Revisar no Asaas'};
const kinds:Record<string,string>={RENT:'Mensalidade',INSTALLMENT:'Parcela',ADHESION:'Adesão',RESIDUAL:'Compra residual',DAMAGE:'Avarias'};
const decimal=(s:string)=>{if(!/^\d+(?:[,.]\d{1,2})?$/.test(s))return NaN;const [a,b='']=s.replace(',','.').split('.');return Number(a)*100+Number(b.padEnd(2,'0'));};
export function OrderBilling({order,perms,active,refresh}:{order:OrderView;perms:Set<string>;active:boolean;refresh:()=>Promise<unknown>}) {
 const [view,setView]=useState<View|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [configOpen,setConfigOpen]=useState(false),[env,setEnv]=useState(''),[key,setKey]=useState(''),[secret,setSecret]=useState(''),[notify,setNotify]=useState('');
 const [first,setFirst]=useState(''),[adhesion,setAdhesion]=useState(''),[fine,setFine]=useState(''),[interest,setInterest]=useState('');
 const [closure,setClosure]=useState(''),[assessment,setAssessment]=useState(''),[damage,setDamage]=useState('0'),[extraDue,setExtraDue]=useState('');
 async function run(body?:Record<string,unknown>) {
  setBusy(true);setError('');
  try {
   const r=await fetch(`/api/billing/orders/${order.id}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
   const data=await r.json();if(!r.ok){setError(data.error||'Operação não concluída.');return false;}setView(data);
   if(body){await refresh();}return true;
  }catch{setError('Falha de comunicação. Atualize a situação antes de repetir.');return false;}
  finally{setBusy(false);}
 }
 const label=(title:string,node:React.ReactNode)=><label className="field">{title}{node}</label>;
 return <section className="stack"><h3 className="section-title">{order.type==='LOCACAO'?'Boletos e encerramento da locação':'Boletos'}</h3>
  <Button variant="outline" disabled={busy} onClick={()=>void run()}>{view?'Atualizar cobranças':'Abrir cobranças'}</Button>
  {error&&<p role="alert" className="notice error">{error}</p>}
  {view&&<>
   <p className="muted">{view.config?`Asaas: ${view.config.environment==='SANDBOX'?'Sandbox (testes, sem quitação real)':'Produção'}`:'Asaas não configurado nesta loja.'}</p>
   {perms.has('PAYMENT_CONFIG')&&<Button variant="outline" disabled={busy||!active} onClick={()=>{setConfigOpen(!configOpen);setEnv(view.config?.environment??'');setNotify(view.config?String(view.config.notificationsEnabled):'');}}>Configurar Asaas da loja</Button>}
   {configOpen&&<form className="form-grid" onSubmit={async e=>{e.preventDefault();if(await run({action:'configure',environment:env,apiKey:key,webhookSecret:secret,notificationsEnabled:notify==='true'})){setKey('');setSecret('');setConfigOpen(false);}}}>
    {label('Ambiente',<select required value={env} onChange={e=>setEnv(e.target.value)}><option value="">Selecione</option><option value="SANDBOX">Sandbox</option><option value="PRODUCTION">Produção — emite cobranças reais</option></select>)}
    {label('Avisos conforme configuração da conta Asaas',<select required value={notify} onChange={e=>setNotify(e.target.value)}><option value="">Selecione</option><option value="true">Habilitar</option><option value="false">Desabilitar</option></select>)}
    {label('API key (em branco mantém a salva)',<input type="password" autoComplete="new-password" value={key} onChange={e=>setKey(e.target.value)}/>)}
    {label('Token do webhook (em branco mantém o salvo)',<input type="password" autoComplete="new-password" value={secret} onChange={e=>setSecret(e.target.value)}/>)}
    <Button disabled={busy||!env||!notify} type="submit">Salvar configuração</Button>
   </form>}
   {view.config?.webhookPath&&<label className="field">URL para cadastrar no webhook Asaas<input readOnly value={typeof window==='undefined'?view.config.webhookPath:window.location.origin+view.config.webhookPath}/></label>}
   {!view.receivables.length&&view.config&&order.status==='COMPLETED'&&perms.has('ORDER_CREATE')&&<form className="form-grid" onSubmit={e=>{e.preventDefault();void run({action:'prepare',firstDueDate:first,adhesionDueDate:adhesion,fineBp:decimal(fine),interestBp:decimal(interest)});}}>
    {order.type==='LOCACAO'?<>
     {label('Primeiro vencimento das 12 mensalidades',<input required type="date" value={first} onChange={e=>setFirst(e.target.value)}/>)}
     {order.adhesionBilling==='BOLETO'&&label('Vencimento da adesão',<input required type="date" value={adhesion} onChange={e=>setAdhesion(e.target.value)}/>)}
     <p className="muted full">Contrato v1: multa de 2% e juros de 1% ao mês.</p>
    </>:<>
     {label('Multa por atraso (%) — informe 0 se não houver',<input required inputMode="decimal" value={fine} onChange={e=>setFine(e.target.value)}/>)}
     {label('Juros por atraso (% ao mês)',<input required inputMode="decimal" value={interest} onChange={e=>setInterest(e.target.value)}/>)}
    </>}
    <p className="muted full">Revise os vencimentos antes de emitir. Parcelas mensais usam o dia inicial; em mês mais curto, o último dia. Eventuais centavos de arredondamento ficam na última parcela.</p>
    <Button disabled={busy||!active} type="submit">Preparar prévia dos boletos</Button>
   </form>}
   {view.receivables.map(r=><div className="note" key={r.id}><strong>{kinds[r.kind]} {r.sequence} · {money(r.amount)}</strong><p>{r.dueDate.split('-').reverse().join('/')} · {labels[r.status]??r.status}{r.environment==='SANDBOX'?' · Teste':''}</p>
    {r.error&&<p className="notice error">{r.error}</p>}
    <div className="form-actions" style={{justifyContent:'flex-start'}}>
     {r.status==='DRAFT'&&perms.has('ORDER_CREATE')&&<Button disabled={busy||!active} onClick={()=>{if(window.confirm(`Emitir ${kinds[r.kind]} de ${money(r.amount)} no Asaas (${r.environment})?`))void run({action:'issue',receivableId:r.id});}}>Emitir boleto</Button>}
     {r.status!=='DRAFT'&&<Button variant="outline" disabled={busy} onClick={()=>void run({action:'refresh',receivableId:r.id})}>Consultar no Asaas</Button>}
     {r.url&&<a href={r.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Abrir boleto</a>}
    </div></div>)}
   {view.closure&&<p className="notice">{view.closure.type==='RETURN'?'Devolução':'Compra'}: {view.closure.status==='COMPLETED'?'concluída':'pendente de conciliação/pagamento'}. {view.closure.assessment}</p>}
   {order.type==='LOCACAO'&&order.status==='COMPLETED'&&perms.has('ORDER_COMPLETE')&&view.closure?.status!=='COMPLETED'&&<>
    <Button variant="outline" disabled={busy||!active} onClick={()=>{setClosure(view.closure?.type??'RETURN');setAssessment(view.closure?.assessment??'');setDamage(((view.closure?.damageAmount??0)/100).toFixed(2));}}>Devolver aparelho / exercer compra</Button>
    {closure&&<form className="form-grid" onSubmit={async e=>{e.preventDefault();if(!window.confirm('Confirmar o encerramento com as condições informadas?'))return;if(await run({action:'closeRental',type:closure,assessment,damageAmount:closure==='RETURN'?decimal(damage):0,damageDueDate:extraDue,residualDueDate:extraDue}))setClosure('');}}>
     {label('Operação',<select value={closure} disabled={!!view.closure} onChange={e=>setClosure(e.target.value)}><option value="RETURN">Devolver aparelho</option><option value="PURCHASE">Compra após quitação</option></select>)}
     {label(closure==='RETURN'?'Avaliação presencial do aparelho':'Registro da opção de compra',<textarea required minLength={5} maxLength={2000} value={assessment} onChange={e=>setAssessment(e.target.value)}/>)}
     {closure==='RETURN'&&label('Orçamento exato de avarias (R$); 0 se não houver',<input required value={damage} onChange={e=>setDamage(e.target.value)} inputMode="decimal"/>)}
     {label('Vencimento do boleto de avarias ou compra residual',<input type="date" value={extraDue} onChange={e=>setExtraDue(e.target.value)}/>)}
     <p className="muted full">Devolução preserva mensalidades vencidas e cancela futuras ainda não pagas. Compra exige quitação da adesão, das 12 mensalidades e dos R$ 19,90. Nenhuma nota fiscal, remoção de iCloud ou negativação é executada por esta ação.</p>
     <Button disabled={busy||!active} type="submit">Confirmar / retomar encerramento</Button>
    </form>}
   </>}
  </>}
 </section>;
}

type Overview={items:{id:string;orderId:string;kind:string;sequence:number;amount:number;dueDate:string;status:string;url:string;environment:string;orderNumber:number;orderType:string;customerName:string;customerDocument:string;customerPhone:string;storeName:string;overdue:boolean;daysOverdue:number;hasAsaasCustomer:boolean}[];totals:{openAmount:number;overdueAmount:number;delinquentCustomers:number;paidAmount:number;needsReview:number}};
type Reminders={reminders:{event:string;enabled:boolean;channels:string[];scheduleOffset:number|null}[]};
const reminderEvents:Record<string,string>={PAYMENT_CREATED:'Cobrança criada',PAYMENT_UPDATED:'Cobrança alterada',PAYMENT_DUEDATE_WARNING:'Aviso de vencimento',SEND_LINHA_DIGITAVEL:'Linha digitável no vencimento',PAYMENT_OVERDUE:'Cobrança vencida',PAYMENT_RECEIVED:'Pagamento recebido'};
const filters:[string,string][]=[['overdue','Vencidos'],['open','Em aberto'],['paid','Pagos'],['all','Todos']];
const br=(d:string)=>d.split('-').reverse().join('/');
/** Controle de boletos de todos os pedidos: inadimplentes, em aberto, pagos e lembretes do Asaas. */
export function BillingOverview({onOpenOrder}:{onOpenOrder:(orderId:string)=>void}) {
 const [open,setOpen]=useState(false),[filter,setFilter]=useState('overdue'),[data,setData]=useState<Overview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [reminders,setReminders]=useState<Record<string,Reminders|string>>({});
 async function load(f=filter) {
  setBusy(true);setError('');
  try{const r=await fetch(`/api/billing/receivables?filter=${f}`);const d=await r.json();if(!r.ok){setError(d.error||'Não foi possível consultar.');return;}setData(d);setFilter(f);}
  catch{setError('Falha de comunicação.');}finally{setBusy(false);}
 }
 async function loadReminders(id:string) {
  setReminders(p=>({...p,[id]:'Consultando o Asaas…'}));
  try{const r=await fetch(`/api/billing/receivables?reminders=${encodeURIComponent(id)}`);const d=await r.json();setReminders(p=>({...p,[id]:r.ok?d:(d.error||'Não foi possível consultar.')}));}
  catch{setReminders(p=>({...p,[id]:'Falha de comunicação.'}));}
 }
 return <section className="panel stack" style={{padding:16,marginBottom:16}}>
  <div className="inline" style={{justifyContent:'space-between',gap:8,flexWrap:'wrap'}}>
   <h3 className="section-title" style={{margin:0}}>Boletos e inadimplência</h3>
   <Button variant="outline" size="sm" disabled={busy} onClick={()=>{if(open&&data){setOpen(false);return;}setOpen(true);void load();}}>{open&&data?'Fechar':'Abrir controle de boletos'}</Button>
  </div>
  {error&&<p role="alert" className="notice error">{error}</p>}
  {open&&data&&<>
   <div className="order-summary">
    <div><span className="muted">Vencido</span><strong>{money(data.totals.overdueAmount)}</strong></div>
    <div><span className="muted">Clientes inadimplentes</span><strong>{data.totals.delinquentCustomers}</strong></div>
    <div><span className="muted">Em aberto (inclui vencido)</span><strong>{money(data.totals.openAmount)}</strong></div>
    <div><span className="muted">Recebido</span><strong>{money(data.totals.paidAmount)}</strong></div>
   </div>
   {data.totals.needsReview>0&&<p className="notice">{data.totals.needsReview} cobrança(s) com envio incerto ou divergente: abra o pedido e use "Consultar no Asaas".</p>}
   <div className="inline" style={{gap:6,flexWrap:'wrap'}}>{filters.map(([k,l])=><Button key={k} size="sm" variant={filter===k?'default':'outline'} disabled={busy} onClick={()=>void load(k)}>{l}</Button>)}<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void load()}>Atualizar</Button></div>
   <p className="muted">Situação conforme a última consulta ao Asaas (webhook ou conferência automática). Lembretes: o Asaas informa quais avisos estão ativos para o cliente e por quais canais, mas não informa pela API se cada aviso já foi entregue — o histórico de envios fica no painel do Asaas.</p>
   {data.items.length?data.items.map(r=><div className="note" key={r.id}>
    <div className="inline" style={{justifyContent:'space-between',gap:8,flexWrap:'wrap'}}>
     <strong>{r.customerName} · {kinds[r.kind]??r.kind} {r.sequence} · {money(r.amount)}</strong>
     <span className={'badge '+(r.overdue?'error':r.status==='PAID'?'success':'neutral')}>{r.overdue?`Vencido há ${r.daysOverdue} dia(s)`:labels[r.status]??r.status}</span>
    </div>
    <p className="muted">Pedido #{r.orderNumber} ({r.orderType==='VENDA'?'moto':'locação'}) · {r.storeName} · vence {br(r.dueDate)} · {r.customerDocument}{r.customerPhone?` · ${r.customerPhone}`:''}{r.environment==='SANDBOX'?' · Teste':''}</p>
    <div className="form-actions" style={{justifyContent:'flex-start'}}>
     <Button size="sm" variant="outline" onClick={()=>onOpenOrder(r.orderId)}>Abrir pedido</Button>
     {r.hasAsaasCustomer&&<Button size="sm" variant="outline" onClick={()=>void loadReminders(r.id)}>Lembretes do Asaas</Button>}
     {r.url&&<a href={r.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Abrir boleto</a>}
    </div>
    {typeof reminders[r.id]==='string'&&<p className="muted">{reminders[r.id] as string}</p>}
    {typeof reminders[r.id]==='object'&&<ul className="muted" style={{margin:'4px 0 0 16px'}}>{(reminders[r.id] as Reminders).reminders.length?(reminders[r.id] as Reminders).reminders.map(n=><li key={n.event+String(n.scheduleOffset)}>{reminderEvents[n.event]??n.event}{n.scheduleOffset!==null?` (${n.scheduleOffset} dia(s))`:''}: {n.enabled&&n.channels.length?`ativo — ${n.channels.join(', ')}`:'desativado'}</li>):<li>Nenhum lembrete configurado para este cliente no Asaas.</li>}</ul>}
   </div>):<p className="muted">Nenhuma cobrança neste filtro.</p>}
  </>}
 </section>;
}
