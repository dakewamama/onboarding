import * as http from "http";
import {timingSafeEqual} from "crypto";
import {CustodyTransferConflict,CustodyTransferNotFound,custodyTransferFromEnv,type CustodyTransferInput,type CustodyTransferService} from "./custodyTransfer";
import {squadsControlStatus} from "./squads";
export interface CustodyTransferMount{handle(req:http.IncomingMessage,res:http.ServerResponse):Promise<boolean>;logStatus(port:number):void;}
function send(res:http.ServerResponse,status:number,body:unknown){res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(body));}
function auth(header:string|undefined,token:string|undefined){if(!header?.startsWith("Bearer ")||!token)return false;const a=Buffer.from(header.slice(7));const b=Buffer.from(token);return a.length===b.length&&timingSafeEqual(a,b);}
function body(req:http.IncomingMessage):Promise<Record<string,unknown>>{return new Promise((resolve,reject)=>{const chunks:Buffer[]=[];let size=0;req.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>16384){reject(new Error("request too large"));req.destroy();return;}chunks.push(chunk);});req.on("end",()=>{try{resolve(chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>:{});}catch(error){reject(error);}});req.on("error",reject);});}
export function mountCustodyTransfer(env:NodeJS.ProcessEnv=process.env):CustodyTransferMount{
 const token=env.INTERNAL_API_TOKEN;const enabled=env.AXIS_CUSTODY_TRANSFER_ENABLED==="true";let service:CustodyTransferService|null=null;let initError="";
 if(enabled){try{service=custodyTransferFromEnv(env);}catch(error){initError=(error as Error).message;}}
 async function handle(req:http.IncomingMessage,res:http.ServerResponse){const url=new URL(req.url??"/","http://localhost");const transfer=url.pathname==="/wallet/transfer"||url.pathname==="/wallet/transfer/status";const treasury=url.pathname==="/treasury/status";if(!transfer&&!treasury)return false;if(!token){send(res,503,{error:"INTERNAL_API_TOKEN not set"});return true;}if(!auth(req.headers.authorization,token)){send(res,401,{error:"unauthorized"});return true;}
  if(treasury){if(req.method!=="GET"){send(res,405,{error:"method"});return true;}try{send(res,200,squadsControlStatus(env));}catch(error){send(res,503,{error:(error as Error).message});}return true;}
  if(!enabled||!service){send(res,503,{error:initError||"AXIS_CUSTODY_TRANSFER_ENABLED is not true"});return true;}
  try{
   if(url.pathname==="/wallet/transfer/status"){if(req.method!=="GET"){send(res,405,{error:"method"});return true;}const key=url.searchParams.get("idempotencyKey");if(!key){send(res,400,{error:"idempotencyKey required"});return true;}const result=await service.status(key);send(res,result.status==="pending"||result.status==="in_doubt"?202:200,result);return true;}
   if(req.method!=="POST"){send(res,405,{error:"method"});return true;}const raw=await body(req);const input:CustodyTransferInput={owner:String(raw.owner??""),asset:String(raw.asset??"") as "USDC",network:String(raw.network??"") as "SOLANA",destination:String(raw.destination??""),amountMinor:String(raw.amountMinor??""),maxDebitMinor:String(raw.maxDebitMinor??""),idempotencyKey:String(raw.idempotencyKey??"")};const result=await service.transfer(input);send(res,result.status==="pending"||result.status==="in_doubt"?202:200,result);return true;
  }catch(error){if(error instanceof CustodyTransferConflict){send(res,409,{error:error.message});return true;}if(error instanceof CustodyTransferNotFound){send(res,404,{error:error.message});return true;}send(res,400,{error:(error as Error).message});return true;}
 }
 return {handle,logStatus(port:number){const transfer=!enabled?"disabled":service?"ready":`unavailable: ${initError}`;let squads="disabled";try{squads=squadsControlStatus(env).configured?"configured":"disabled";}catch(error){squads=`invalid: ${(error as Error).message}`;}console.log(`[custody] /wallet/transfer on :${port} ${transfer}; squads ${squads}`);}};
}
