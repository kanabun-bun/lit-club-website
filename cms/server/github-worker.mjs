import {configured,session,issueSession,passwordMatches,cookie,clearCookie} from './auth.mjs';
import {validateContent,normalize} from './model.mjs';
import {GitHubStore,HttpError,githubConfigured,boundedBytes,MAX_PDF} from './github-store.mjs';
import {DriveStore,driveEnabled,driveConfigured} from './drive-store.mjs';
const json=(x,status=200,headers={})=>Response.json(x,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
async function input(request){try{return JSON.parse(new TextDecoder().decode(await boundedBytes(request,1_200_000)));}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'入力形式を確認してください');}}
const check=(ok,message)=>{if(!ok)throw new HttpError(400,message);};
const text=(x,max,required=false)=>typeof x==='string'&&x.length<=max&&(!required||!!x.trim());
const stamp=()=>new Date().toISOString();
export async function routeGitHub(request,env,fetcher=fetch){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(!path.startsWith('/api/'))return env.ASSETS?env.ASSETS.fetch(request):new Response('Not found',{status:404});
 if(!['GET','POST','PUT','DELETE'].includes(method))return json({error:'許可されていない操作です'},405);
 if(method!=='GET'&&request.headers.get('origin')!==url.origin)return json({error:'送信元を確認できません'},403);
 const ready=githubConfigured(env),auth=configured(env)&&!!env.LOGIN_LIMITER&&!!env.API_LIMITER;
 if(path==='/api/status'&&method==='GET')return json({backend:'github',database:ready,storage:ready,auth,pdfUpload:ready&&auth,records:ready&&auth,publicSync:ready,maxPdfBytes:MAX_PDF,pdfBackend:driveEnabled(env)?'drive':'github',driveReady:driveConfigured(env)});
 if(path==='/api/logout'&&method==='POST')return json({ok:true},200,{'Set-Cookie':clearCookie});
 const user=await session(request,env);
 if(path==='/api/session'&&method==='GET')return json({role:user?.role||'guest'});
 if(path.startsWith('/api/admin/')&&user?.role!=='admin')return json({error:'管理者ログインが必要です'},403);
 if(path.startsWith('/api/member/')&&!user)return json({error:'部員ログインが必要です'},401);
 if(!ready||!auth)return json({error:'非公開GitHub保存先・認証・アクセス制限の初期設定待ちです'},503);
 const ip=request.headers.get('CF-Connecting-IP');if(!ip)return json({error:'アクセス元を確認できません'},503);
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip))),x=>x.toString(16).padStart(2,'0')).join('');
 if(!(await env.API_LIMITER.limit({key:digest})).success)return json({error:'アクセスが集中しています。少し待ってください'},429);
 if(path==='/api/login'&&method==='POST'){
  if(!(await env.LOGIN_LIMITER.limit({key:digest})).success)return json({error:'ログイン試行回数の上限です。少し待ってください'},429);
  const x=await input(request);check(['member','admin'].includes(x?.role),'ログイン種別を選んでください');
  if(!await passwordMatches(x.password,x.role==='admin'?env.ADMIN_PASSWORD:env.MEMBER_PASSWORD))return json({error:'パスワードが違います'},401);
  return json({role:x.role},200,{'Set-Cookie':cookie(await issueSession(x.role,env))});
 }
 const store=new GitHubStore(env,fetcher),snapshot=await store.load(),state=snapshot.state;
 const reply=(x,status=200)=>json({...x,revision:snapshot.revision},status);
 const commit=async(action,target,files=[],extra={})=>{const revision=await store.save(snapshot,request.headers.get('X-CMS-Revision'),action,target,files);return json({ok:true,...extra,revision});};
 if(path==='/api/public/entries'&&method==='GET'){
  const q=normalize(url.searchParams.get('q')||'').slice(0,200);
  return reply({items:state.entries.filter(e=>e.published!==null).map(e=>({id:e.id,kind:e.kind,content:validateContent(e.kind,e.published)})).filter(e=>!q||normalize(Object.values(e.content).join(' ')).includes(q))});
 }
 if(path==='/api/member/works'&&method==='GET'){
  const q=normalize(url.searchParams.get('q')||'').slice(0,200);
  const authorLabels=new Map(state.authors.map(a=>[a.id,a.label]));
  return reply({items:state.works.filter(w=>w.member_status==='published'&&normalize([w.title,w.credited_name,authorLabels.get(w.author_id)||'',w.search_text].join(' ')).includes(q)).map(w=>({id:w.id,title:w.title,author:w.credited_name,hasPdf:!!(w.pdf_key||w.pdf_drive)}))});
 }
 const pdf=path.match(/^\/api\/member\/works\/([a-zA-Z0-9-]+)\/pdf$/);
 if(pdf&&method==='GET'){
  const w=state.works.find(w=>w.id===pdf[1]&&w.member_status==='published'&&(w.pdf_key||w.pdf_drive));if(!w)return json({error:'PDFがありません'},404);
  const bytes=w.pdf_drive?await new DriveStore(env,fetcher).pdf(w.pdf_drive):await store.pdf(snapshot,w);
  return new Response(bytes,{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="work.pdf"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'self'"}});
 }
 if(path==='/api/admin/snapshot'&&method==='GET')return reply({entries:state.entries,authors:state.authors,works:state.works});
 const collection=path.match(/^\/api\/admin\/(authors|works|entries)$/);
 if(collection){const kind=collection[1];if(method==='GET')return reply({items:state[kind]});if(method==='POST'){
  const x=await input(request),id=crypto.randomUUID();check(x&&typeof x==='object','入力形式を確認してください');
  if(kind==='authors'){check(text(x.label,100,true)&&['current','alumni'].includes(x.membership),'作者情報を確認してください');state.authors.push({id,label:x.label.trim(),membership:x.membership,version:1});}
  if(kind==='works'){check(text(x.title,200,true)&&text(x.credited_name,100)&&state.authors.some(a=>a.id===x.author_id),'作品と作者を確認してください');state.works.push({id,author_id:x.author_id,title:x.title.trim(),credited_name:x.credited_name.trim(),search_text:'',member_status:'draft',pdf_key:null,pdf_bytes:0,version:1,updated_at:stamp()});}
  if(kind==='entries'){const content=validateContent(x.kind,x.content);check(x.kind!=='introduction'||state.works.some(w=>w.id===content.workId),'対象作品がありません');state.entries.push({id,kind:x.kind,draft:content,published:null,version:1,updated_at:stamp()});}
  return commit(kind+'-create',id,[],{id});
 }}
 const edit=path.match(/^\/api\/admin\/(authors|works|entries)\/([a-zA-Z0-9-]+)(\/pdf|\/drive-pdf)?$/);
 if(edit){const [,kind,id,suffix]=edit,row=state[kind].find(x=>x.id===id);if(!row)return json({error:'対象データがありません'},404);
  if(suffix==='/drive-pdf'&&kind==='works'&&['PUT','DELETE'].includes(method)){
   if(!driveEnabled(env))return json({error:'Drive参照先が未設定です'},503);
   const expected=request.headers.get('X-CMS-Revision');
   if(!expected||expected!==snapshot.revision)return json({error:'一覧を再読み込みしてから保存してください'},expected?409:428);
   const x=await input(request);
   check(['draft','published'].includes(x.member_status)&&text(x.search_text||'',10000),'公開状態と検索キーワードを確認してください（1万文字以内）');
   const linked=method==='DELETE'?null:await new DriveStore(env,fetcher).attach(x.file);
   row.pdf_drive=linked;row.pdf_key=null;row.pdf_bytes=0;
   row.member_status=linked?x.member_status:'draft';row.search_text=x.search_text||'';row.updated_at=stamp();row.version++;
   return commit(linked?'drive-pdf-link':'drive-pdf-unlink',id,[],{message:linked?'DriveのPDFと公開状態を保存しました。':'掲載を解除しました。Driveの原本は削除していません。'});
  }
  if(suffix&&kind==='works'&&method==='PUT'){
   if(driveEnabled(env))return json({error:'PDFはDriveへアップロードし、管理画面で関連付けてください'},400);
   const bytes=await boundedBytes(request,MAX_PDF);check(new TextDecoder().decode(bytes.subarray(0,5))==='%PDF-','PDFファイルを選んでください');
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
   const key='pdfs/'+id+'-'+hash+'.pdf',files=[{path:key,bytes}];if(row.pdf_key&&row.pdf_key!==key)files.push({path:row.pdf_key});
   row.pdf_drive=null;row.pdf_key=key;row.pdf_bytes=bytes.length;row.updated_at=stamp();row.version++;return commit('pdf-save',id,files,{bytes:bytes.length});
  }
  if(suffix)return json({error:'未対応の操作です'},404);
  if(method==='DELETE'){
   const files=[];
   if(kind==='authors'&&state.works.some(w=>w.author_id===id))return json({error:'この作者に作品が残っています。先に作品の作者を変更するか、作品を削除してください'},409);
   if(kind==='entries'){const x=await input(request);if(x?.version!==row.version)return json({error:'別の編集が入りました。一覧を再読み込みしてください'},409);}
   if(kind==='works'){state.entries=state.entries.filter(e=>e.kind!=='introduction'||(e.draft.workId!==id&&e.published?.workId!==id));if(row.pdf_key)files.push({path:row.pdf_key});}
   state[kind]=state[kind].filter(x=>x.id!==id);return commit(kind+'-delete',id,files);
  }
  if(method==='PUT'){
   const x=await input(request);check(x&&typeof x==='object','入力形式を確認してください');
   if(kind==='authors'){check(text(x.label,100,true)&&['current','alumni'].includes(x.membership),'作者情報を確認してください');row.label=x.label.trim();row.membership=x.membership;}
   if(kind==='works'){
    if('title'in x){check(text(x.title,200,true)&&text(x.credited_name,100)&&state.authors.some(a=>a.id===x.author_id),'作品と作者を確認してください');row.title=x.title.trim();row.credited_name=x.credited_name.trim();row.author_id=x.author_id;}
    else{check(['draft','published'].includes(x.member_status)&&text(x.search_text||'',1_000_000),'会員公開状態・検索本文を確認してください');check(x.member_status!=='published'||row.pdf_key||row.pdf_drive,'先にPDFを登録してください');row.member_status=x.member_status;row.search_text=x.search_text||'';}
   }
   if(kind==='entries'){
    if(x.version!==row.version)return json({error:'別の編集が入りました。一覧を再読み込みしてください'},409);
    check(['save','publish','unpublish'].includes(x.action),'操作を選んでください');const c=validateContent(row.kind,x.content);check(row.kind!=='introduction'||state.works.some(w=>w.id===c.workId),'対象作品がありません');row.draft=c;if(x.action==='publish')row.published=structuredClone(c);if(x.action==='unpublish')row.published=null;
   }
   row.version=(row.version||1)+1;row.updated_at=stamp();return commit(kind+'-'+(x.action||'save'),id);
  }
 }
 return json({error:'未対応の操作です'},404);
}
export default {async fetch(request,env){try{return await routeGitHub(request,env);}catch(e){if(e instanceof HttpError)return json({error:e.message},e.status);if(e.message?.startsWith('入力')||e.message?.includes('してください'))return json({error:e.message},400);console.error('CMS request failed',e.name);return json({error:'処理を完了できませんでした。保存状態を再読み込みして確認してください'},503);}}};
