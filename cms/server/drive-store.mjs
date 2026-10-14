import {HttpError,boundedBytes,MAX_PDF,base64} from './github-store.mjs';
const enc=new TextEncoder();
const idPattern=/^[A-Za-z0-9_-]{10,200}$/;
const b64url=bytes=>base64(bytes).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
export const driveEnabled=env=>!!env.DRIVE_FOLDER_ID;
export const driveConfigured=env=>idPattern.test(env.DRIVE_FOLDER_ID||'')&&!!env.DRIVE_SERVICE_ACCOUNT_JSON;
export function driveFileId(value){
 if(typeof value!=='string')throw new HttpError(400,'DriveのPDFのURLまたはファイルIDを入力してください');
 let id=value.trim();
 if(!idPattern.test(id)){
  let u;try{u=new URL(id);}catch{throw new HttpError(400,'DriveのPDFのURLを確認してください');}
  if(u.protocol!=='https:'||u.hostname!=='drive.google.com')throw new HttpError(400,'drive.google.comのPDFのURLを入力してください');
  id=u.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1]||(u.pathname==='/open'?u.searchParams.get('id'):null);
 }
 if(!idPattern.test(id||''))throw new HttpError(400,'PDFファイルのURLを入力してください。フォルダのURLは使用できません');
 return id;
}
export class DriveStore{
 constructor(env,fetcher=fetch){this.env=env;this.fetcher=fetcher.bind(globalThis);}
 async token(){
  if(this.accessToken)return this.accessToken;
  if(!driveConfigured(this.env))throw new HttpError(503,'Drive接続の初期設定待ちです');
  let c,key;
  try{
   c=JSON.parse(this.env.DRIVE_SERVICE_ACCOUNT_JSON);
   if(c.type!=='service_account'||!c.client_email?.endsWith('.gserviceaccount.com')||typeof c.private_key!=='string')throw Error();
   const pem=c.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,'');
   key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),x=>x.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  }catch{throw new HttpError(503,'Driveのサービスアカウント設定を確認してください');}
  const now=Math.floor(Date.now()/1000),header=b64url(enc.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const claims=b64url(enc.encode(JSON.stringify({iss:c.client_email,scope:'https://www.googleapis.com/auth/drive.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})));
  const signed=header+'.'+claims;
  const assertion=signed+'.'+b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,enc.encode(signed))));
  const r=await this.fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}).toString()});
  if(!r.ok)throw new HttpError(503,'Googleへの認証に失敗しました。サービスアカウントの鍵とAPI設定を確認してください');
  const data=await r.json();if(typeof data.access_token!=='string'||!data.access_token)throw new HttpError(503,'Googleへの認証を完了できませんでした');
  return this.accessToken=data.access_token;
 }
 async request(path,stage='Driveへの接続'){
  const token=await this.token();
  const r=await this.fetcher('https://www.googleapis.com/drive/v3/'+path,{redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token}});
  if(!r.ok){
   let reason='UNKNOWN';
   const allowed=new Set(['SERVICE_DISABLED','ACCESS_TOKEN_SCOPE_INSUFFICIENT','RATE_LIMIT_EXCEEDED','BILLING_DISABLED','insufficientPermissions','insufficientFilePermissions','appNotAuthorizedToFile','downloadRestrictedForRevision','domainPolicy','dailyLimitExceeded','rateLimitExceeded','userRateLimitExceeded','accessNotConfigured','forbidden','authError','notFound']);
   try{const body=JSON.parse(new TextDecoder().decode(await boundedBytes(r,32000))),e=body.error;
    const candidates=[...(e?.details||[]).map(x=>x.reason),...(e?.errors||[]).map(x=>x.reason)];reason=candidates.find(x=>allowed.has(x))||'UNKNOWN';
   }catch{}
   const detail='【'+stage+' / HTTP '+r.status+' / '+reason+'】';
   if(reason==='SERVICE_DISABLED'||reason==='accessNotConfigured')throw new HttpError(503,'JSON鍵を作成したプロジェクトでGoogle Drive APIを有効にしてください。'+detail);
   if(r.status===404)throw new HttpError(503,'DriveのPDFまたはフォルダが見つかりません。配置と共有設定を確認してください。'+detail);
   throw new HttpError(503,'Driveの読み取り権限・API設定・利用上限を確認してください。'+detail);
  }
  return r;
 }
 async metadata(id){
  const fields='id,name,mimeType,size,parents,trashed';
  return (await this.request('files/'+encodeURIComponent(id)+'?supportsAllDrives=true&fields='+encodeURIComponent(fields),id===this.env.DRIVE_FOLDER_ID?'フォルダ情報の取得':'PDF情報の取得')).json();
 }
 async privatePermissions(id){
  let page='';let count=0;
  do{
   const q=new URLSearchParams({supportsAllDrives:'true',fields:'nextPageToken,permissions(type)',pageSize:'100'});if(page)q.set('pageToken',page);
   const data=await (await this.request('files/'+encodeURIComponent(id)+'/permissions?'+q,id===this.env.DRIVE_FOLDER_ID?'フォルダの共有設定の確認':'PDFの共有設定の確認')).json();
   if(!Array.isArray(data.permissions)||data.permissions.length===0||data.permissions.some(p=>!['user','group'].includes(p.type)))throw new HttpError(503,'Driveの共有設定を制限付きにしてください。全員・組織全体への公開は使用できません');
   page=data.nextPageToken||'';if(++count>10)throw new HttpError(503,'Driveの共有設定を確認できませんでした');
  }while(page);
 }
 async inspect(id){
  if(!idPattern.test(id||''))throw new HttpError(400,'DriveのPDFのIDを確認してください');
  if(!driveConfigured(this.env))throw new HttpError(503,'Drive接続の初期設定待ちです');
  const folder=await this.metadata(this.env.DRIVE_FOLDER_ID);
  if(folder.trashed||folder.mimeType!=='application/vnd.google-apps.folder')throw new HttpError(503,'Driveの参照フォルダを確認してください');
  await this.privatePermissions(this.env.DRIVE_FOLDER_ID);
  const file=await this.metadata(id),size=Number(file.size);
  if(file.trashed||file.mimeType!=='application/pdf'||!file.parents?.includes(this.env.DRIVE_FOLDER_ID))throw new HttpError(400,'指定フォルダ直下にあるPDFを選んでください（ショートカット・サブフォルダは対象外です）');
  if(!Number.isSafeInteger(size)||size<=0||size>MAX_PDF)throw new HttpError(413,'PDFは10MB以内にしてください');
  await this.privatePermissions(id);
  return {id,folder_id:this.env.DRIVE_FOLDER_ID,name:String(file.name||'PDF').slice(0,300),size};
 }
 async content(info){
  const bytes=await boundedBytes(await this.request('files/'+encodeURIComponent(info.id)+'?alt=media&supportsAllDrives=true','PDF本体の取得'),MAX_PDF);
  if(bytes.length!==info.size||new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')throw new HttpError(503,'DriveのPDFの整合性を確認できませんでした');
  return {bytes,sha256:await hash(bytes)};
 }
 async attach(value){const info=await this.inspect(driveFileId(value));const {sha256}=await this.content(info);return {...info,sha256};}
 async pdf(saved){
  if(saved.folder_id!==this.env.DRIVE_FOLDER_ID)throw new HttpError(503,'PDFの参照フォルダが変更されています。管理者が再登録してください');
  const info=await this.inspect(saved.id),{bytes,sha256}=await this.content(info);
  if(saved.size!==info.size||saved.sha256!==sha256)throw new HttpError(409,'DriveのPDFが変更されています。管理者が関連付けを再登録してください');
  return bytes;
 }
}
