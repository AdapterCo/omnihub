import { database } from '@/db/database';
import { receiveAsaasEvent } from '@/lib/billing/service';
export async function POST(request:Request,context:{params:Promise<{key:string}>}) {
 const {key}=await context.params;
 if(!/^[a-f0-9]{48}$/.test(key))return new Response(null,{status:404});
 if(Number(request.headers.get('content-length'))>100000)return new Response(null,{status:413});
 const text=await request.text();if(text.length>100000)return new Response(null,{status:413});
 try {const status=await receiveAsaasEvent(database(),key,request.headers.get('asaas-access-token')??'',JSON.parse(text));return new Response(null,{status});}
 catch{return new Response(null,{status:400});}
}
