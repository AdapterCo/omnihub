'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {FileDown,Layers,LoaderCircle,RefreshCw} from 'lucide-react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {money,type OrderView,type StoreRecord} from '@/lib/domain';
type View={config:{environment:string;notificationsEnabled:boolean;webhookPath:string|null}|null;receivables:{id:string;kind:string;sequence:number;amount:number;dueDate:string;status:string;providerStatus:string;url:string;error:string;environment:string}[];closure:{type:string;status:string;assessment:string;damageAmount:number}|null};
const labels:Record<string,string>={DRAFT:'Preparado',CREATING:'Enviando',UNCERTAIN:'Conferir no Asaas',OPEN:'Aguardando pagamento',OVERDUE:'Vencido',PAID:'Pago',CANCELLED:'Cancelado',REFUNDED:'Estornado',REVIEW:'Revisar no Asaas'};
const kinds:Record<string,string>={RENT:'Mensalidade',INSTALLMENT:'Parcela',ADHESION:'Adesão',RESIDUAL:'Compra residual',DAMAGE:'Avarias'};
const decimal=(s:string)=>{if(!/^\d+(?:[,.]\d{1,2})?$/.test(s))return NaN;const [a,b='']=s.replace(',','.').split('.');return Number(a)*100+Number(b.padEnd(2,'0'));};
export function OrderBilling({order,perms,active,refresh}:{order:OrderView;perms:Set<string>;active:boolean;refresh:()=>Promise<unknown>}) {
 const [view,setView]=useState<View|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [first,setFirst]=useState(''),[adhesion,setAdhesion]=useState(''),[fine,setFine]=useState(''),[interest,setInterest]=useState('');
 const [closure,setClosure]=useState(''),[assessment,setAssessment]=useState(''),[damage,setDamage]=useState('0'),[extraDue,setExtraDue]=useState('');
 const [notice,setNotice]=useState(''),[merged,setMerged]=useState<{documentId:string;count:number}|null>(null);
 // Devolve a resposta da rota (ou null em erro), para as ações em lote lerem o resultado.
 async function run(body?:Record<string,unknown>):Promise<Record<string,unknown>|null> {
  setBusy(true);setError('');setNotice('');
  try {
   const r=await fetch(`/api/billing/orders/${order.id}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
   const data=await r.json();if(!r.ok){setError(data.error||'Operação não concluída.');return null;}setView(data);
   if(body){await refresh();}return data;
  }catch{setError('Falha de comunicação. Atualize a situação antes de repetir.');return null;}
  finally{setBusy(false);}
 }
 const label=(title:string,node:React.ReactNode)=><label className="field">{title}{node}</label>;
 return <section className="stack"><h3 className="section-title">{order.type==='LOCACAO'?'Boletos e encerramento da locação':'Boletos'}</h3>
  <Button variant="outline" disabled={busy} onClick={()=>void run()}>{view?'Atualizar cobranças':'Abrir cobranças'}</Button>
  {error&&<p role="alert" className="notice error">{error}</p>}
  {notice&&<p className="notice">{notice}</p>}
  {view&&<>
   <p className="muted">{view.config?`Asaas: ${view.config.environment==='SANDBOX'?'Sandbox (testes, sem quitação real)':'Produção'}`:'Asaas não configurado nesta loja. Configure em Minhas lojas > Boletos (Asaas).'}</p>
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
   {(()=>{const drafts=view.receivables.filter(r=>r.status==='DRAFT');const openOnes=view.receivables.filter(r=>r.url&&['OPEN','OVERDUE'].includes(r.status));const env=view.config?.environment==='SANDBOX'?'Sandbox (teste)':'Produção';
    return (drafts.length>0||openOnes.length>0)&&<div className="notice" style={{marginBottom:0}}>
     {drafts.length>0&&perms.has('ORDER_CREATE')&&<div><strong>{drafts.length} boleto(s) preparado(s) · total {money(drafts.reduce((a,r)=>a+r.amount,0))}.</strong> Confira os vencimentos e valores abaixo e emita todos de uma vez para entregar ao cliente no ato da compra.
      <div className="form-actions" style={{justifyContent:'flex-start',marginTop:8}}><Button disabled={busy||!active} onClick={async()=>{if(!window.confirm(`Emitir ${drafts.length} boleto(s) no Asaas (${env}), total ${money(drafts.reduce((a,r)=>a+r.amount,0))}?`))return;const d=await run({action:'issueAll'});const res=d?.issueAll as {issued:number;total:number;error:string|null}|undefined;if(res){if(res.error)setError(`${res.issued} de ${res.total} boleto(s) emitido(s). Parou em: ${res.error}`);else setNotice(`${res.issued} boleto(s) emitido(s) no Asaas.`);}}}>{busy?<LoaderCircle size={16} className="animate-spin"/>:<Layers size={16}/>} Emitir todos os boletos ({drafts.length})</Button></div></div>}
     {openOnes.length>0&&<div style={{marginTop:drafts.length?12:0}}><strong>{openOnes.length} boleto(s) emitido(s) em aberto.</strong> Junte todos num único PDF para enviar ao cliente; o arquivo também fica salvo em Documentos do pedido.
      <div className="form-actions" style={{justifyContent:'flex-start',marginTop:8,alignItems:'center'}}><Button variant="outline" disabled={busy} onClick={async()=>{setMerged(null);const d=await run({action:'mergeBoletos'});const m=d?.merged as {documentId:string;count:number}|undefined;if(m){setMerged(m);setNotice(`PDF com ${m.count} boleto(s) salvo em Documentos do pedido.`);}}}>{busy?<LoaderCircle size={16} className="animate-spin"/>:<FileDown size={16}/>} Salvar todos em um PDF ({openOnes.length})</Button>
       {merged&&<><a className="underline" href={`/api/documents/${merged.documentId}?download=1`}>Baixar PDF</a><a className="underline" href={`/api/documents/${merged.documentId}`} target="_blank" rel="noopener noreferrer">Abrir</a></>}</div></div>}
    </div>;})()}
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

type Totals={overdueAmount:number;overdueCount:number;delinquentCustomers:number;upcomingAmount:number;upcomingCount:number;openAmount:number;paidAmount:number;paidCount:number;allCount:number;needsReview:number};
type Overview={items:{id:string;orderId:string;kind:string;sequence:number;amount:number;dueDate:string;status:string;url:string;environment:string;orderNumber:number;orderType:string;customerName:string;customerDocument:string;customerPhone:string;storeName:string;overdue:boolean;daysOverdue:number;hasAsaasCustomer:boolean}[];totals:Totals};
type Reminders={reminders:{event:string;enabled:boolean;channels:string[];scheduleOffset:number|null}[]};
const reminderEvents:Record<string,string>={PAYMENT_CREATED:'Cobrança criada',PAYMENT_UPDATED:'Cobrança alterada',PAYMENT_DUEDATE_WARNING:'Aviso de vencimento',SEND_LINHA_DIGITAVEL:'Linha digitável no vencimento',PAYMENT_OVERDUE:'Cobrança vencida',PAYMENT_RECEIVED:'Pagamento recebido'};
// Filtros com o significado escrito na tela (antes "Em aberto" incluía os vencidos, o que confundia).
const FILTERS:{key:string;label:string;hint:string;count:(t:Totals)=>number;empty:string}[]=[
 {key:'overdue',label:'Vencidos',hint:'Passaram do vencimento e ainda não foram pagos.',count:t=>t.overdueCount,empty:'Nenhum boleto vencido.'},
 {key:'upcoming',label:'A vencer',hint:'Emitidos e dentro do prazo (vencimento de hoje em diante).',count:t=>t.upcomingCount,empty:'Nenhum boleto a vencer.'},
 {key:'paid',label:'Pagos',hint:'Pagamento confirmado pelo Asaas.',count:t=>t.paidCount,empty:'Nenhum boleto pago ainda.'},
 {key:'all',label:'Todos',hint:'Todos os boletos, inclusive preparados (ainda não emitidos) e cancelados.',count:t=>t.allCount,empty:'Nenhum boleto registrado.'},
];
const br=(d:string)=>d.split('-').reverse().join('/');
/** Aba "Boletos e inadimplência": boletos de todos os pedidos, inadimplentes e lembretes do Asaas. */
export function BillingOverview({onOpenOrder}:{onOpenOrder:(orderId:string)=>void}) {
 const [filter,setFilter]=useState('overdue'),[data,setData]=useState<Overview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loadedAt,setLoadedAt]=useState<number|null>(null);
 const [reminders,setReminders]=useState<Record<string,Reminders|string>>({});
 async function load(f=filter) {
  setBusy(true);setError('');
  try{const r=await fetch(`/api/billing/receivables?filter=${f}`,{cache:'no-store'});const d=await r.json();if(!r.ok){setError(d.error||'Não foi possível consultar.');return;}setData(d);setFilter(f);setLoadedAt(Date.now());}
  catch{setError('Falha de comunicação.');}finally{setBusy(false);}
 }
 useEffect(()=>{void load('overdue')},[]); // eslint-disable-line react-hooks/exhaustive-deps
 async function loadReminders(id:string) {
  setReminders(p=>({...p,[id]:'Consultando o Asaas…'}));
  try{const r=await fetch(`/api/billing/receivables?reminders=${encodeURIComponent(id)}`);const d=await r.json();setReminders(p=>({...p,[id]:r.ok?d:(d.error||'Não foi possível consultar.')}));}
  catch{setReminders(p=>({...p,[id]:'Falha de comunicação.'}));}
 }
 const t:Totals=data?.totals??{overdueAmount:0,overdueCount:0,delinquentCustomers:0,upcomingAmount:0,upcomingCount:0,openAmount:0,paidAmount:0,paidCount:0,allCount:0,needsReview:0};
 const active=FILTERS.find(f=>f.key===filter)??FILTERS[0];
 const card=(label:string,value:string,hint:string,tone='')=><section className="metric"><span>{label}</span><strong style={tone==='error'?{color:'#a52431'}:tone==='success'?{color:'#13734f'}:undefined}>{value}</strong><small>{hint}</small></section>;
 return <>
  {error&&<p role="alert" className="notice error">{error}</p>}
  <div className="metrics">
   {card('Vencido',money(t.overdueAmount),`${t.overdueCount} boleto(s) em atraso`,t.overdueAmount>0?'error':'')}
   {card('Clientes inadimplentes',String(t.delinquentCustomers),'com ao menos 1 boleto vencido',t.delinquentCustomers>0?'error':'')}
   {card('A vencer',money(t.upcomingAmount),`${t.upcomingCount} boleto(s) dentro do prazo`)}
   {card('Recebido',money(t.paidAmount),`${t.paidCount} boleto(s) pagos`,t.paidAmount>0?'success':'')}
  </div>
  {t.needsReview>0&&<p className="notice">{t.needsReview} cobrança(s) com envio incerto ou divergente: abra o pedido e use &quot;Consultar no Asaas&quot;.</p>}
  <section className="panel">
   <div className="panel-heading" style={{flexWrap:'wrap'}}>
    <div role="tablist" aria-label="Filtrar boletos" className="inline" style={{gap:6,flexWrap:'wrap'}}>
     {FILTERS.map(f=><Button key={f.key} role="tab" aria-selected={filter===f.key} size="sm" variant={filter===f.key?'default':'outline'} disabled={busy} onClick={()=>void load(f.key)}>{f.label}<span className={'badge '+(filter===f.key?'':'neutral')} style={{marginLeft:6,padding:'2px 8px'}}>{f.count(t)}</span></Button>)}
    </div>
    <Button size="sm" variant="outline" disabled={busy} onClick={()=>void load()} title="Recarrega a lista com a situação mais recente já recebida do Asaas">{busy?<LoaderCircle size={14} className="animate-spin"/>:<RefreshCw size={14}/>} Atualizar lista</Button>
   </div>
   <p className="muted" style={{padding:'12px 23px 0'}}><strong>{active.label}:</strong> {active.hint}{loadedAt?` Lista atualizada às ${new Date(loadedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}.`:''} A situação de cada boleto chega do Asaas sozinha (aviso de pagamento e conferência automática).</p>
   <div style={{padding:'8px 23px 20px'}}>
    {data&&data.items.length?data.items.map(r=><div className="note" key={r.id}>
     <div className="inline" style={{justifyContent:'space-between',gap:8,flexWrap:'wrap'}}>
      <strong>{r.customerName} · {kinds[r.kind]??r.kind} {r.sequence} · {money(r.amount)}</strong>
      <span className={'badge '+(r.overdue?'error':r.status==='PAID'?'success':'neutral')}>{r.overdue?`Vencido há ${r.daysOverdue} dia(s)`:labels[r.status]??r.status}</span>
     </div>
     <p className="muted">Pedido #{r.orderNumber} ({r.orderType==='VENDA'?'moto':'locação'}) · {r.storeName} · vence {br(r.dueDate)} · {r.customerDocument}{r.customerPhone?` · ${r.customerPhone}`:''}{r.environment==='SANDBOX'?' · Teste':''}</p>
     <div className="form-actions" style={{justifyContent:'flex-start',marginTop:8}}>
      <Button size="sm" variant="outline" onClick={()=>onOpenOrder(r.orderId)}>Abrir pedido</Button>
      {r.hasAsaasCustomer&&<Button size="sm" variant="outline" onClick={()=>void loadReminders(r.id)}>Lembretes do Asaas</Button>}
      {r.url&&<a className="underline" href={r.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Abrir boleto</a>}
     </div>
     {typeof reminders[r.id]==='string'&&<p className="muted">{reminders[r.id] as string}</p>}
     {typeof reminders[r.id]==='object'&&<ul className="muted" style={{margin:'4px 0 0 16px'}}>{(reminders[r.id] as Reminders).reminders.length?(reminders[r.id] as Reminders).reminders.map(n=><li key={n.event+String(n.scheduleOffset)}>{reminderEvents[n.event]??n.event}{n.scheduleOffset!==null?` (${n.scheduleOffset} dia(s))`:''}: {n.enabled&&n.channels.length?`ativo — ${n.channels.join(', ')}`:'desativado'}</li>):<li>Nenhum lembrete configurado para este cliente no Asaas.</li>}</ul>}
    </div>):<p className="muted">{busy&&!data?'Carregando…':active.empty}</p>}
    <p className="muted" style={{marginTop:12}}>Lembretes: o Asaas informa quais avisos estão ativos para o cliente e por quais canais, mas não informa pela API se cada aviso já foi entregue — o histórico de envios fica no painel do Asaas.</p>
   </div>
  </section>
 </>;
}

type BillingSummary={configured:boolean;environment:string;notificationsEnabled:boolean;webhookPath:string|null;updatedAt:number|null;environmentLocked:boolean};
// Token forte para o webhook: gerado no navegador (nunca sai daqui antes de salvar) para o usuário
// colar o mesmo valor no painel do Asaas.
function newWebhookToken(){const a=new Uint8Array(24);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');}
/** Minhas lojas > Boletos (Asaas): conta Asaas da loja para os boletos dos pedidos (moto e locação). */
export function BillingConfigDialog({store,onClose}:{store:StoreRecord;onClose:()=>void}) {
 const [summary,setSummary]=useState<BillingSummary|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const [env,setEnv]=useState(''),[key,setKey]=useState(''),[secret,setSecret]=useState(''),[notify,setNotify]=useState(''),[showSecret,setShowSecret]=useState(false),[copied,setCopied]=useState('');
 const call=async(body?:unknown)=>{setBusy(true);setError('');try{const r=await fetch(`/api/billing/stores/${store.id}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});const d=await r.json();if(!r.ok){setError(d.error||'Não foi possível concluir.');return false}setSummary(d);if(!body){setEnv(d.environment||'');setNotify(d.configured?String(d.notificationsEnabled):'')}return true}catch{setError('Falha de comunicação.');return false}finally{setBusy(false)}};
 useEffect(()=>{void call()},[]); // eslint-disable-line react-hooks/exhaustive-deps
 const webhookUrl=summary?.webhookPath&&typeof window!=='undefined'?window.location.origin+summary.webhookPath:'';
 const copy=async(text:string,what:string)=>{try{await navigator.clipboard.writeText(text);setCopied(what)}catch{setCopied('')}};
 const save=async(e:React.FormEvent)=>{e.preventDefault();if(await call({environment:env,apiKey:key.trim()||undefined,webhookSecret:secret.trim()||undefined,notificationsEnabled:notify==='true'})){setKey('');setSaved(true)}};
 const field=(title:React.ReactNode,node:React.ReactNode,full=false)=><label className={'field'+(full?' full':'')}>{title}{node}</label>;
 return <Dialog open onOpenChange={o=>{if(!o)onClose()}}><DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
  <DialogHeader><DialogTitle>Boletos (Asaas) · {store.name}</DialogTitle><DialogDescription>Conta Asaas desta loja para emitir os boletos das parcelas da moto e das mensalidades da locação. Cada loja usa a própria conta.</DialogDescription></DialogHeader>
  {error&&<div className="notice error" role="alert">{error}</div>}
  {saved&&<div className="notice">Configuração salva.{secret?' Cadastre agora o webhook no Asaas com a URL e o token abaixo (passo 3).':''}</div>}
  <section className="notice" style={{marginBottom:12}}>
   <strong>Passo a passo</strong>
   <ol style={{margin:'6px 0 0 18px',listStyle:'decimal'}}>
    <li><strong>Teste primeiro no Sandbox:</strong> crie uma conta de testes em sandbox.asaas.com (nenhum boleto é cobrado de verdade). Quando tudo estiver certo, repita com a conta real e escolha Produção.</li>
    <li><strong>API key:</strong> no painel do Asaas, menu Integrações &gt; Chaves de API, gere uma chave e cole abaixo.</li>
    <li><strong>Webhook:</strong> no Asaas, Integrações &gt; Webhooks &gt; novo webhook para <em>cobranças</em>, com a URL que aparece aqui depois de salvar e o mesmo token de autenticação que você salvar abaixo (use &quot;Gerar token&quot;). É ele que avisa o OmniHub quando um boleto é pago.</li>
    <li><strong>Lembretes:</strong> quem envia os avisos de vencimento e atraso por e-mail/WhatsApp/SMS é o próprio Asaas, conforme as notificações configuradas na conta dele.</li>
   </ol>
  </section>
  {summary&&<p className="muted">{summary.configured?<>Situação: <strong>configurado · {summary.environment==='SANDBOX'?'Sandbox (testes)':'Produção'}</strong>. Campos de chave e token em branco mantêm os valores salvos.</>:<>Situação: <strong>não configurado</strong>.</>}</p>}
  <form className="form-grid" onSubmit={save}>
   {field('Ambiente',<select required value={env} disabled={summary?.environmentLocked} onChange={e=>setEnv(e.target.value)}><option value="">Selecione</option><option value="SANDBOX">Sandbox — testes, sem cobrança real</option><option value="PRODUCTION">Produção — emite boletos reais</option></select>)}
   {field('Avisos do Asaas ao cliente',<select required value={notify} onChange={e=>setNotify(e.target.value)}><option value="">Selecione</option><option value="true">Enviar (conforme as notificações da conta Asaas)</option><option value="false">Não enviar</option></select>)}
   {summary?.environmentLocked&&<p className="muted full">O ambiente não pode mais ser trocado: esta loja já tem boletos nele (a conciliação se perderia).</p>}
   {field(summary?.configured?'API key (em branco mantém a salva)':'API key do Asaas',<input type="password" autoComplete="new-password" required={!summary?.configured} value={key} onChange={e=>setKey(e.target.value)} placeholder="$aact_..."/>,true)}
   {field(summary?.configured?'Token do webhook (em branco mantém o salvo)':'Token de autenticação do webhook (mín. 32 caracteres)',<div className="inline" style={{gap:6}}><input className="search-input" type={showSecret?'text':'password'} autoComplete="new-password" required={!summary?.configured} minLength={32} maxLength={255} value={secret} onChange={e=>setSecret(e.target.value)}/><Button type="button" size="sm" variant="outline" onClick={()=>{setSecret(newWebhookToken());setShowSecret(true)}}>Gerar token</Button>{secret&&<Button type="button" size="sm" variant="outline" onClick={()=>void copy(secret,'token')}>{copied==='token'?'Copiado':'Copiar'}</Button>}</div>,true)}
   {secret&&<p className="muted full">Copie este token antes de salvar: depois de salvo ele não é mostrado de novo. Cole o mesmo valor no campo &quot;Token de autenticação&quot; do webhook no Asaas.</p>}
   <div className="form-actions full" style={{marginTop:0}}><Button disabled={busy||!env||!notify}>{busy?'Salvando...':'Salvar configuração'}</Button></div>
  </form>
  {webhookUrl&&<div className="field full" style={{marginTop:12}}>URL do webhook (cadastre no Asaas com os eventos de cobrança)
   <div className="inline" style={{gap:6}}><input className="search-input" readOnly value={webhookUrl} onFocus={e=>e.currentTarget.select()}/><Button type="button" size="sm" variant="outline" onClick={()=>void copy(webhookUrl,'url')}>{copied==='url'?'Copiado':'Copiar'}</Button></div></div>}
  <section className="muted" style={{marginTop:12}}>
   <strong>Como usar depois de configurado:</strong> finalize o pedido na loja (aba Pedidos) → abra o pedido → Boletos → <em>Abrir cobranças</em> → <em>Preparar prévia dos boletos</em> (confira vencimentos e valores) → <em>Emitir boleto</em> em cada parcela. O link de cada boleto aparece ali para enviar ao cliente, e o painel <em>Boletos e inadimplência</em> da aba Pedidos mostra o que está vencido.
  </section>
 </DialogContent></Dialog>;
}
