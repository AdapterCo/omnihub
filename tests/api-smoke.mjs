import assert from 'node:assert/strict';
const origin='http://127.0.0.1:5173';
const anonymous=await fetch(origin+'/api/workspace');assert.equal(anonymous.status,401,await anonymous.text());
const login=await fetch(origin+'/signin-with-chatgpt?return_to=/',{redirect:'manual'});const cookies=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');assert.ok(cookies,'Local sign-in cookie missing');
const headers={'Content-Type':'application/json',Origin:origin,Cookie:cookies};
const get=()=>fetch(origin+'/api/workspace',{headers:{Cookie:cookies}});
let r=await get();assert.equal(r.status,200,await r.clone().text());let d=await r.json();
if(d.setup){r=await fetch(origin+'/api/workspace',{method:'POST',headers,body:JSON.stringify({type:'account.create',name:'Validação local'})});assert.equal(r.status,201,await r.clone().text());d=await r.json()}
const denied=await fetch(origin+'/api/workspace',{method:'POST',headers:{...headers,Origin:'https://invalid.example'},body:'{}'});assert.equal(denied.status,403);
const first={command:{type:'store.create',data:{name:'Loja teste API'}},key:crypto.randomUUID(),revision:d.revision};
if(d.state.stores.length<3){r=await fetch(origin+'/api/workspace',{method:'POST',headers,body:JSON.stringify(first)});assert.equal(r.status,200,await r.clone().text());const saved=await r.json();assert.equal(saved.state.stores.length,d.state.stores.length+1);r=await fetch(origin+'/api/workspace',{method:'POST',headers,body:JSON.stringify(first)});assert.equal(r.status,200);const replay=await r.json();assert.equal(replay.revision,saved.revision);const concurrent=await fetch(origin+'/api/workspace',{method:'POST',headers,body:JSON.stringify({...first,key:crypto.randomUUID(),command:{type:'store.update',id:saved.resultId,data:{name:'Stale'}}})});assert.equal(concurrent.status,409);d=saved}
const forbidden=await fetch(origin+'/api/workspace',{method:'POST',headers,body:JSON.stringify({key:crypto.randomUUID(),revision:d.revision,command:{type:'subscription.activate'}})});assert.equal(forbidden.status,400);
const reread=await (await get()).json();assert.equal(reread.account.name,'Validação local');assert.ok(reread.account.subscription.accessUntil>Date.now());assert.deepEqual(reread.state.requests,{});
console.log('API OK: anonymous rejection, sign-in, persistent account, CSRF, writes, idempotent replay, revision conflict, subscription tampering rejected.');
