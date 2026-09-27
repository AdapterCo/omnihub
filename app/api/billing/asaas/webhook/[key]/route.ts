import { database } from '@/db/database';
import { receiveAsaasEvent } from '@/lib/billing/service';
import { readTextLimited, readJsonLimited, BodyTooLargeError } from '@/lib/http/body';
export async function POST(request:Request,context:{params:Promise<{key:string}>}) {
 const {key}=await context.params;
 if(!/^[a-f0-9]{48}$/.test(key))return new Response(null,{status:404});
 let text:string;try{text=await readTextLimited(request,100000)}catch(e){if(e instanceof BodyTooLargeError)return new Response(null,{status:413});throw e}
 try {const status=await receiveAsaasEvent(database(),key,request.headers.get('asaas-access-token')??'',JSON.parse(text));return new Response(null,{status});}
 catch{return new Response(null,{status:400});}
}
