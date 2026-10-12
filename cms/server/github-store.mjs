import {validateContent} from './model.mjs';
export class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
export const STATE_PATH='data/state.json';
export const MAX_STATE=4_000_000,MAX_PDF=10_000_000;
const encoder=new TextEncoder();
export function base64(bytes){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
export async function boundedBytes(response,max){
 if(Number(response.headers.get('Content-Length'))>max)throw new HttpError(413,'保存容量の上限です');
 const reader=response.body?.getReader();if(!reader)return new Uint8Array();const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new HttpError(413,'保存容量の上限です');}chunks.push(value);}}finally{reader.releaseLock();}
 const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
const identifier=x=>typeof x==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(x);
export function validateState(state){
 if(!state||state.schemaVersion!==1||!Number.isSafeInteger(state.version)||state.version<1||!['authors','works','entries','audit'].every(k=>Array.isArray(state[k])))throw new HttpError(503,'保存データの形式を確認してください。自動初期化は行いません');
 for(const kind of ['authors','works','entries']){const ids=new Set();for(const row of state[kind]){if(!identifier(row?.id)||ids.has(row.id))throw new HttpError(503,'保存データに不正または重複したIDがあります');ids.add(row.id);}}
 const authors=new Set(state.authors.map(x=>x.id)),works=new Set(state.works.map(x=>x.id));
 for(const a of state.authors)if(typeof a.label!=='string'||!a.label.trim()||a.label.length>100||!['current','alumni'].includes(a.membership))throw new HttpError(503,'作者データを確認してください');
 for(const w of state.works)if(!authors.has(w.author_id)||typeof w.title!=='string'||!w.title.trim()||w.title.length>200||typeof w.credited_name!=='string'||w.credited_name.length>100||typeof w.search_text!=='string'||w.search_text.length>1_000_000||!['draft','published'].includes(w.member_status)||!Number.isSafeInteger(w.version)||w.version<1||!Number.isSafeInteger(w.pdf_bytes)||w.pdf_bytes<0||w.pdf_bytes>MAX_PDF||(w.pdf_key!==null&&!/^pdfs\/[a-zA-Z0-9-]+-[a-f0-9]{64}\.pdf$/.test(w.pdf_key))||(w.member_status==='published'&&!w.pdf_key))throw new HttpError(503,'作品データを確認してください');
 for(const e of state.entries){if(!Number.isSafeInteger(e.version)||e.version<1||!e.draft)throw new HttpError(503,'記事の版番号を確認してください');for(const c of [e.draft,e.published])if(c!==null){try{validateContent(e.kind,c);}catch{throw new HttpError(503,'記事データを確認してください');}if(e.kind==='introduction'&&!works.has(c.workId))throw new HttpError(503,'作品紹介の参照先がありません');}}
 return state;
}
export function githubConfigured(env){return /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_DATA_REPO||'')&&!!env.GITHUB_TOKEN&&!!env.GITHUB_DATA_BRANCH;}
export class GitHubStore {
 constructor(env,fetcher=fetch){this.env=env;this.fetcher=fetcher;this.root='https://api.github.com/repos/'+env.GITHUB_DATA_REPO;}
 async request(path,options={},raw=false){
  const response=await this.fetcher(this.root+path,{...options,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Accept:raw?'application/vnd.github.raw+json':'application/vnd.github+json',Authorization:'Bearer '+this.env.GITHUB_TOKEN,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'lit-club-cms','Content-Type':'application/json',...options.headers}});
  if(!response.ok){if(response.status===409||response.status===422)throw new HttpError(409,'別の更新が入りました。一覧を再読み込みしてください');if(response.status===403||response.status===429)throw new HttpError(503,'GitHubの権限または利用上限を確認してください');if(response.status===404)throw new HttpError(503,'保存先または初期データが見つかりません');throw new HttpError(503,'GitHubへの接続を完了できませんでした');}
  return raw?response:response.json();
 }
 async load(){
  // Never use a public repo for drafts, search text or PDFs, even after a privacy change.
  const repo=await this.request('');if(repo.private!==true||repo.archived)throw new HttpError(503,'CMS保存先には書き込み可能な非公開リポジトリを指定してください');
  const ref=await this.request('/git/ref/heads/'+this.env.GITHUB_DATA_BRANCH.split('/').map(encodeURIComponent).join('/'));
  const revision=ref.object.sha;
  const commit=await this.request('/git/commits/'+revision);
  const response=await this.request('/contents/'+STATE_PATH+'?ref='+revision,{},true);
  let state;try{state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBytes(response,MAX_STATE)));}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(503,'保存データが破損しています。バックアップを確認してください');}
  return {state:validateState(state),revision,tree:commit.tree.sha};
 }
 async save(snapshot,expected,action,target,files=[]){
  if(!expected)throw new HttpError(428,'一覧を読み込んでから保存してください');
  if(expected!==snapshot.revision)throw new HttpError(409,'別の更新が入りました。一覧を再読み込みしてください');
  const state=snapshot.state;state.version++;state.audit.push({action,target_id:target,actor:'shared-admin',created_at:new Date().toISOString()});state.audit=state.audit.slice(-500);
  validateState(state);const text=JSON.stringify(state,null,2)+'\n';if(encoder.encode(text).length>MAX_STATE)throw new HttpError(413,'文章データが上限です。登録を停止しました');
  if(state.works.reduce((n,w)=>n+w.pdf_bytes,0)>Number(this.env.MAX_ACTIVE_PDF_BYTES||256_000_000))throw new HttpError(413,'PDFの保存容量が上限です。登録を停止しました');
  const elements=[{path:STATE_PATH,mode:'100644',type:'blob',content:text}];
  for(const file of files){if(file.bytes){const blob=await this.request('/git/blobs',{method:'POST',body:JSON.stringify({content:base64(file.bytes),encoding:'base64'})});elements.push({path:file.path,mode:'100644',type:'blob',sha:blob.sha});}else elements.push({path:file.path,mode:'100644',type:'blob',sha:null});}
  const tree=await this.request('/git/trees',{method:'POST',body:JSON.stringify({base_tree:snapshot.tree,tree:elements})});
  const commit=await this.request('/git/commits',{method:'POST',body:JSON.stringify({message:'CMS '+action+' '+target,tree:tree.sha,parents:[snapshot.revision]})});
  // A concurrent sibling commit cannot fast-forward: metadata and PDFs stay atomic.
  await this.request('/git/refs/heads/'+this.env.GITHUB_DATA_BRANCH.split('/').map(encodeURIComponent).join('/'),{method:'PATCH',body:JSON.stringify({sha:commit.sha,force:false})});
  return commit.sha;
 }
 async pdf(snapshot,work){
  const r=await this.request('/contents/'+work.pdf_key+'?ref='+snapshot.revision,{},true);
  const bytes=await boundedBytes(r,MAX_PDF);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  if(bytes.length!==work.pdf_bytes||!work.pdf_key.endsWith('-'+hash+'.pdf')||new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')throw new HttpError(503,'PDFの整合性を確認できませんでした');
  return bytes;
 }
}
