const encoder=new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), x=>x.toString(16).padStart(2,'0')).join('');
async function digest(value){return hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));}
async function sign(value,secret){const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));}
function equal(a,b){if(a.length!==b.length)return false;let different=0;for(let i=0;i<a.length;i++)different|=a.charCodeAt(i)^b.charCodeAt(i);return different===0;}
export function configured(env){return !!(env.SESSION_SECRET?.length>=32 && env.MEMBER_PASSWORD?.length>=16 && env.ADMIN_PASSWORD?.length>=16 && env.MEMBER_PASSWORD!==env.ADMIN_PASSWORD);}
export async function issueSession(role,env){
 const password=role==='admin'?env.ADMIN_PASSWORD:env.MEMBER_PASSWORD;
 const value=btoa(JSON.stringify({role,expires:Date.now()+8*60*60*1000,epoch:await digest(password),nonce:crypto.randomUUID()}));
 return value+'.'+await sign(value,env.SESSION_SECRET);
}
export async function session(request,env){
 if(!configured(env))return null;
 const token=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-club='))?.slice(12);
 if(!token || token.length>2048)return null;
 try{
  const [value,signature,...extra]=token.split('.');
  if(extra.length || !signature || !equal(await sign(value,env.SESSION_SECRET),signature))return null;
  const data=JSON.parse(atob(value));
  if(!['member','admin'].includes(data.role) || data.expires<=Date.now())return null;
  const password=data.role==='admin'?env.ADMIN_PASSWORD:env.MEMBER_PASSWORD;
  if(!equal(data.epoch,await digest(password)))return null;
  return data;
 }catch{return null;}
}
export async function passwordMatches(input,expected){return typeof input==='string' && input.length<=512 && equal(await digest(input),await digest(expected));}
export const cookie = token => '__Host-club='+token+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800';
export const clearCookie='__Host-club=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0';
