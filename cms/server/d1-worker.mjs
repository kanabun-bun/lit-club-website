import {configured,session,issueSession,passwordMatches,cookie,clearCookie} from './auth.mjs';
import {kinds,validateContent,publicEntry,normalize} from './model.mjs';
const json=(body,status=200,extra={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});
async function body(request){const text=await request.text();if(text.length>150000)throw new Error('入力が大きすぎます');return JSON.parse(text);}
function needed(env){if(!env.DB)throw new Error('DB_UNCONNECTED');}
function changes(result){return result.meta?.changes || 0;}
export async function route(request,env){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(!path.startsWith('/api/'))return env.ASSETS?env.ASSETS.fetch(request):new Response('Not found',{status:404});
 if(!['GET','POST','PUT'].includes(method))return json({error:'許可されていない操作です'},405);
 if(method!=='GET' && request.headers.get('origin')!==url.origin)return json({error:'送信元を確認できません'},403);
 if(path==='/api/status')return json({database:!!env.DB,storage:!!env.PDFS,auth:configured(env),pdfUpload:false});
 if(path==='/api/logout' && method==='POST')return json({ok:true},200,{'Set-Cookie':clearCookie});
 const user=await session(request,env);
 if(path==='/api/session')return json({role:user?.role||'guest'});
 if(path==='/api/login' && method==='POST'){
  if(!configured(env) || !env.DB)return json({error:'ログイン設定とデータベースの接続待ちです'},503);
  const input=await body(request);
  if(!['member','admin'].includes(input.role))return json({error:'ログイン種別を選んでください'},400);
  const ip=request.headers.get('CF-Connecting-IP')||'local';
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const now=Date.now();
  // Count attempts BEFORE password verification; UPSERT handles concurrent requests.
  const attempt=await env.DB.prepare("INSERT INTO login_attempts(key,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN expires_at<=? THEN 1 ELSE attempts+1 END,expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END RETURNING attempts").bind(hash,now+900000,now,now,now+900000).first();
  if(attempt.attempts>10)return json({error:'試行回数の上限です。15分ほど待ってください'},429);
  const expected=input.role==='admin'?env.ADMIN_PASSWORD:env.MEMBER_PASSWORD;
  if(!await passwordMatches(input.password,expected))return json({error:'パスワードが違います'},401);
  return json({role:input.role},200,{'Set-Cookie':cookie(await issueSession(input.role,env))});
 }
 if(path.startsWith('/api/admin/') && user?.role!=='admin')return json({error:'管理者ログインが必要です'},403);
 if(path.startsWith('/api/member/') && !user)return json({error:'会員ログインが必要です'},401);
 needed(env);
 if(path==='/api/public/entries' && method==='GET'){
  const result=await env.DB.prepare('SELECT id,kind,published_json FROM entries WHERE published_json IS NOT NULL').all();
  const q=normalize(url.searchParams.get('q')||'');
  return json({items:result.results.map(publicEntry).filter(x=>!q||normalize(Object.values(x.content).join(' ')).includes(q))});
 }
 if(path==='/api/admin/authors'){
  if(method==='GET')return json({items:(await env.DB.prepare('SELECT * FROM authors ORDER BY label').all()).results});
  if(method==='POST'){
   const x=await body(request);if(typeof x.label!=='string'||!x.label.trim()||x.label.length>100||!['current','alumni'].includes(x.membership))return json({error:'作者情報を確認してください'},400);
   const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO authors(id,label,membership) VALUES(?,?,?)').bind(id,x.label.trim(),x.membership).run();return json({id},201);
  }
 }
 if(path==='/api/admin/works'){
  if(method==='GET')return json({items:(await env.DB.prepare('SELECT * FROM works ORDER BY updated_at DESC').all()).results});
  if(method==='POST'){
   const x=await body(request);
   if(typeof x.title!=='string'||!x.title.trim()||x.title.length>200||typeof x.credited_name!=='string'||x.credited_name.length>100||!await env.DB.prepare('SELECT id FROM authors WHERE id=?').bind(x.author_id||'').first())return json({error:'作品名と作者を確認してください'},400);
   const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO works(id,author_id,title,credited_name,updated_at) VALUES(?,?,?,?,?)').bind(id,x.author_id,x.title.trim(),x.credited_name.trim(),new Date().toISOString()).run();return json({id},201);
  }
 }
 if(path==='/api/member/works' && method==='GET'){
  const q=normalize(url.searchParams.get('q')||'').slice(0,200);
  // Full text stays server-side; return only permitted catalogue fields.
  const rows=(await env.DB.prepare("SELECT id,title,credited_name,search_text,pdf_key FROM works WHERE member_status='published'").all()).results;
  return json({items:rows.filter(x=>normalize(x.title+' '+x.credited_name+' '+x.search_text).includes(q)).map(x=>({id:x.id,title:x.title,author:x.credited_name,hasPdf:!!x.pdf_key}))});
 }
 const pdf=path.match(/^\/api\/member\/works\/([a-zA-Z0-9-]+)\/pdf$/);
 if(pdf && method==='GET'){
  if(!env.PDFS)return json({error:'PDF保存先の接続待ちです'},503);
  const work=await env.DB.prepare("SELECT pdf_key FROM works WHERE id=? AND member_status='published'").bind(pdf[1]).first();
  if(!work?.pdf_key)return json({error:'作品が見つかりません'},404);
  const object=await env.PDFS.get(work.pdf_key);if(!object)return json({error:'PDFが見つかりません'},404);
  return new Response(object.body,{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 }
 if(path==='/api/admin/entries'){
  if(method==='GET')return json({items:(await env.DB.prepare('SELECT * FROM entries ORDER BY updated_at DESC').all()).results.map(row=>({...row,draft:JSON.parse(row.draft_json),published:row.published_json?JSON.parse(row.published_json):null,draft_json:undefined,published_json:undefined}))});
  if(method==='POST'){
   const x=await body(request),content=validateContent(x.kind,x.content);
   if(x.kind==='introduction' && !await env.DB.prepare('SELECT id FROM works WHERE id=?').bind(content.workId).first())return json({error:'対象作品がありません'},400);
   const id=crypto.randomUUID();
   await env.DB.batch([env.DB.prepare('INSERT INTO entries(id,kind,draft_json,updated_at) VALUES(?,?,?,?)').bind(id,x.kind,JSON.stringify(content),new Date().toISOString()),env.DB.prepare('INSERT INTO audit(action,target_id) VALUES(?,?)').bind('create',id)]);
   return json({id},201);
  }
 }
 const edit=path.match(/^\/api\/admin\/entries\/([a-zA-Z0-9-]+)$/);
 if(edit && method==='PUT'){
  const x=await body(request),row=await env.DB.prepare('SELECT * FROM entries WHERE id=?').bind(edit[1]).first();
  if(!row)return json({error:'見つかりません'},404);
  if(!['save','publish','unpublish'].includes(x.action))return json({error:'操作を選んでください'},400);
  const content=validateContent(row.kind,x.content);
  if(row.kind==='introduction' && !await env.DB.prepare('SELECT id FROM works WHERE id=?').bind(content.workId).first())return json({error:'対象作品がありません'},400);
  // Optimistic locking protects another editor's changes; publishing includes current form.
  const published=x.action==='publish'?JSON.stringify(content):x.action==='unpublish'?null:row.published_json;
  const result=await env.DB.batch([
   env.DB.prepare('UPDATE entries SET draft_json=?,published_json=?,version=version+1,updated_at=? WHERE id=? AND version=?').bind(JSON.stringify(content),published,new Date().toISOString(),row.id,x.version),
   env.DB.prepare('INSERT INTO audit(action,target_id) SELECT ?,? WHERE changes()=1').bind(x.action,row.id)
  ]);
  if(!changes(result[0]))return json({error:'別の編集が入りました。一覧を再読み込みしてください'},409);
  return json({ok:true});
 }
 return json({error:'未対応の操作です'},404);
}
export default {async fetch(request,env){try{return await route(request,env);}catch(error){if(error.message==='DB_UNCONNECTED')return json({error:'データベースの接続待ちです'},503);if(error instanceof SyntaxError || error instanceof TypeError)return json({error:'入力形式を確認してください'},400);if(error.message.startsWith('入力')||error.message.includes('してください'))return json({error:error.message},400);console.error('CMS request failed',error.name);return json({error:'処理を完了できませんでした'},500);}}};
