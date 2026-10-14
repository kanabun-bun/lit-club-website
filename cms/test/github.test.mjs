import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GitHubStore,HttpError,validateState,STATE_PATH,MAX_PDF} from '../server/github-store.mjs';
import {routeGitHub} from '../server/github-worker.mjs';
import {issueSession,cookie} from '../server/auth.mjs';
const seed=JSON.parse(readFileSync(new URL('../seed.json',import.meta.url)));
function initial(){return {schemaVersion:1,version:1,authors:seed.authors.map(a=>({...a,membership:'current',version:1})),works:seed.works.map(w=>({...w,search_text:'',member_status:'draft',pdf_key:null,pdf_bytes:0,version:1})),entries:seed.entries.map(e=>({id:e.id,kind:e.kind,draft:e.content,published:e.content,version:1})),audit:[]};}
function fake(){
 let serial=0;const f={head:'head0',private:true,commits:new Map(),trees:new Map(),blobs:new Map(),calls:[],race:false,corrupt:false};
 f.commits.set(f.head,{tree:'tree0',parent:null});f.trees.set('tree0',new Map([[STATE_PATH,new TextEncoder().encode(JSON.stringify(initial()))]]));
 f.state=()=>JSON.parse(new TextDecoder().decode(f.trees.get(f.commits.get(f.head).tree).get(STATE_PATH)));
 f.fetch=async(url,options={})=>{
  const u=new URL(url),path=u.pathname.replace('/repos/test/private',''),x=options.body?JSON.parse(options.body):{};f.calls.push({path,options});
  const ok=x=>Response.json(x),id=prefix=>prefix+(++serial);
  if(path==='')return ok({private:f.private,archived:false});
  if(path==='/git/ref/heads/main')return ok({object:{sha:f.head}});
  if(path.startsWith('/git/commits/')&&(!options.method||options.method==='GET'))return ok({tree:{sha:f.commits.get(path.split('/').at(-1)).tree}});
  if(path.startsWith('/contents/')){const files=f.trees.get(f.commits.get(u.searchParams.get('ref')).tree),bytes=files.get(path.slice(10));return bytes?new Response(f.corrupt?'invalid':bytes):new Response('',{status:404});}
  if(path==='/git/blobs'){const sha=id('blob');f.blobs.set(sha,new Uint8Array(Buffer.from(x.content,'base64')));return ok({sha});}
  if(path==='/git/trees'){
   const files=new Map(f.trees.get(x.base_tree));for(const e of x.tree){if(e.sha===null)files.delete(e.path);else files.set(e.path,e.content!==undefined?new TextEncoder().encode(e.content):f.blobs.get(e.sha));}const sha=id('tree');f.trees.set(sha,files);return ok({sha});
  }
  if(path==='/git/commits'){const sha=id('commit');f.commits.set(sha,{tree:x.tree,parent:x.parents[0]});return ok({sha});}
  if(path==='/git/refs/heads/main'){
   if(f.race){f.race=false;const old=f.commits.get(f.head);f.head='concurrent';f.commits.set(f.head,{...old,parent:null});}
   if(f.commits.get(x.sha).parent!==f.head||x.force)return new Response('',{status:422});f.head=x.sha;return ok({});
  }
  throw Error('Unexpected API '+path);
 };return f;
}
const env={GITHUB_DATA_REPO:'test/private',GITHUB_DATA_BRANCH:'main',GITHUB_TOKEN:'server-secret',MEMBER_PASSWORD:'reader-test-only-long-password',ADMIN_PASSWORD:'admin-test-only-long-password',SESSION_SECRET:'test-only-session-secret-at-least-32-characters',LOGIN_LIMITER:{async limit(){return {success:true};}},API_LIMITER:{async limit(){return {success:true};}}};
async function client(f,role='admin',extra={}){
 const settings={...env,...extra},token=role?await issueSession(role,settings):'';let revision=f.head;
 const request=async(path,method='GET',data,options={})=>{
  const headers={'CF-Connecting-IP':'192.0.2.1',Cookie:token?cookie(token):'',Origin:'https://club.example','X-CMS-Revision':revision,...options.headers};
  const req=new Request('https://club.example'+path,{method,headers,body:data===undefined?undefined:data instanceof Uint8Array?data:JSON.stringify(data)});
  let response;try{response=await routeGitHub(req,settings,f.fetch);}catch(e){if(!(e instanceof HttpError))throw e;response=Response.json({error:e.message},{status:e.status});}
  const output=response.headers.get('Content-Type')?.includes('pdf')?new Uint8Array(await response.arrayBuffer()):await response.json();
  if(response.ok&&output.revision)revision=output.revision;return {response,status:response.status,data:output};
 };return {request,setRevision(x){revision=x;}};
}
test('GitHub CRUD: snapshots, public publish/unpublish, preserve all existing IDs',async()=>{
 const f=fake(),c=await client(f);assert.equal((await c.request('/api/admin/snapshot')).data.works.length,14);
 const created=await c.request('/api/admin/entries','POST',{kind:'page',content:{title:'新しい活動',body:'下書き'}}),id=created.data.id;
 assert.equal((await c.request('/api/public/entries')).data.items.some(e=>e.id===id),false);
 const change={version:1,action:'publish',content:{title:'新しい活動',body:'公開版'}};
 assert.equal((await c.request('/api/admin/entries/'+id,'PUT',change)).status,200);
 change.version=2;change.action='save';change.content.body='秘密の下書き';await c.request('/api/admin/entries/'+id,'PUT',change);
 const publicItems=(await c.request('/api/public/entries')).data.items;
 assert.equal(publicItems.find(e=>e.id===id).content.body,'公開版');assert(!JSON.stringify(publicItems).includes('秘密'));
 change.version=3;change.action='unpublish';await c.request('/api/admin/entries/'+id,'PUT',change);
 assert(!(await c.request('/api/public/entries')).data.items.some(e=>e.id===id));assert.equal(f.state().authors.length,14);assert.equal(f.state().works.length,14);
});
test('guest and member never access admin; guest never reaches private GitHub for PDFs',async()=>{
 const f=fake(),guest=await client(f,null),member=await client(f,'member');
 assert.equal((await guest.request('/api/member/works/work-4/pdf')).status,401);
 assert.equal((await guest.request('/api/admin/snapshot')).status,403);assert.equal((await member.request('/api/admin/works')).status,403);assert.equal(f.calls.length,0);
});
test('login rate limiter and foreign origin fail before storage access',async()=>{
 const f=fake(),c=await client(f,null,{LOGIN_LIMITER:{async limit(){return {success:false};}}});
 assert.equal((await c.request('/api/login','POST',{role:'member',password:env.MEMBER_PASSWORD})).status,429);
 assert.equal((await c.request('/api/login','POST',{}, {headers:{Origin:'https://evil.example'}})).status,403);assert.equal(f.calls.length,0);
});
test('a public data repo or corrupt JSON is never silently initialized',async()=>{
 const f=fake(),c=await client(f);f.private=false;assert.equal((await c.request('/api/admin/snapshot')).status,503);f.private=true;f.corrupt=true;assert.equal((await c.request('/api/admin/snapshot')).status,503);assert.equal(f.head,'head0');
});
test('missing and stale revisions cannot update GitHub',async()=>{
 const f=fake(),c=await client(f),old=f.head;
 const x={kind:'page',content:{title:'試験'}};
 assert.equal((await c.request('/api/admin/entries','POST',x,{headers:{'X-CMS-Revision':''}})).status,428);
 await c.request('/api/admin/entries','POST',x);c.setRevision(old);
 assert.equal((await c.request('/api/admin/entries','POST',x)).status,409);assert.equal(f.state().entries.length,7);
});
test('race at final branch update never overwrites concurrent commit',async()=>{
 const f=fake(),c=await client(f);f.race=true;
 assert.equal((await c.request('/api/admin/entries','POST',{kind:'page',content:{title:'競合'}})).status,409);assert.equal(f.head,'concurrent');assert.equal(f.state().entries.length,6);
 const patch=f.calls.find(c=>c.path==='/git/refs/heads/main');assert.equal(JSON.parse(patch.options.body).force,false);
});
test('PDF atomic upload, private search projection, integrity checks, replacement and delete',async()=>{
 const f=fake(),admin=await client(f),bytes=new TextEncoder().encode('%PDF-1.4\nprivate story\n%%EOF'),key='work-4';
 assert.equal((await admin.request('/api/admin/works/'+key,'PUT',{member_status:'published',search_text:'全文の秘密'})).status,400);
 assert.equal((await admin.request('/api/admin/works/'+key+'/pdf','PUT',bytes)).status,200);
 await admin.request('/api/admin/works/'+key,'PUT',{member_status:'published',search_text:'全文の秘密'});
 const member=await client(f,'member'),search=(await member.request('/api/member/works?q='+encodeURIComponent('秘密'))).data;
 assert.equal(search.items.length,1);assert(!JSON.stringify(search).includes('pdfs/'));assert(!JSON.stringify(search).includes('全文'));
 assert.deepEqual((await member.request('/api/member/works/'+key+'/pdf')).data,bytes);
 const old=f.state().works.find(w=>w.id===key).pdf_key;
 await admin.request('/api/admin/works/'+key+'/pdf','PUT',new TextEncoder().encode('%PDF-1.4\nreplacement\n%%EOF'));
 assert(!f.trees.get(f.commits.get(f.head).tree).has(old));
 const current=f.state().works.find(w=>w.id===key);f.trees.get(f.commits.get(f.head).tree).set(current.pdf_key,new TextEncoder().encode('%PDF-damaged'));
 assert.equal((await member.request('/api/member/works/'+key+'/pdf')).status,503);
 admin.setRevision(f.head);assert.equal((await admin.request('/api/admin/works/'+key,'DELETE')).status,200);assert(!f.state().entries.some(e=>e.id==='seed-introduction'));
});
test('oversize PDF and total quota rejection leave the existing branch unchanged',async()=>{
 const f=fake(),c=await client(f,'admin',{MAX_ACTIVE_PDF_BYTES:'1'}),old=f.head;
 assert.equal((await c.request('/api/admin/works/work-4/pdf','PUT',new TextEncoder().encode('%PDF-1.4 test'))).status,413);
 assert.equal((await c.request('/api/admin/works/work-4/pdf','PUT',new Uint8Array(MAX_PDF+1))).status,413);assert.equal(f.head,old);
});
test('author edit keeps per-work credited name; referenced author deletion refused',async()=>{
 const f=fake(),c=await client(f);
 await c.request('/api/admin/authors/author-4','PUT',{label:'管理名変更',membership:'alumni'});
 assert.equal(f.state().works.find(w=>w.id==='work-4').credited_name,seed.works[4].credited_name);
 assert.equal((await c.request('/api/admin/authors/author-4','DELETE')).status,409);
});
test('unknown private fields are removed from public projection',async()=>{
 const f=fake(),files=f.trees.get('tree0'),state=f.state();state.entries[0].published.search_text='SECRET';state.entries[0].published.password='SECRET';files.set(STATE_PATH,new TextEncoder().encode(JSON.stringify(state)));
 const c=await client(f,null);assert(!(JSON.stringify((await c.request('/api/public/entries')).data)).includes('SECRET'));
});
test('broken references and duplicate IDs block data writes',()=>{
 const x=initial();x.works[0].author_id='missing';assert.throws(()=>validateState(x),HttpError);
 const y=initial();y.authors.push(y.authors[0]);assert.throws(()=>validateState(y),HttpError);
});
test('PDF and metadata are in the same tree/commit, not two separate writes',async()=>{
 const f=fake(),c=await client(f);await c.request('/api/admin/works/work-4/pdf','PUT',new TextEncoder().encode('%PDF-1.4 test'));
 const trees=f.calls.filter(x=>x.path==='/git/trees');assert.equal(trees.length,1);const tree=JSON.parse(trees[0].options.body).tree;assert(tree.some(e=>e.path===STATE_PATH));assert(tree.some(e=>e.path.startsWith('pdfs/')));
 assert.equal(f.calls.filter(x=>x.path==='/git/refs/heads/main').length,1);
});

import {driveFileId,DriveStore} from '../server/drive-store.mjs';
const testFolder='1SF0SzqwWQmlDouLO4EKhZGlGEqwmZmMh',testDriveId='sampleDrivePdf12345';
let testIdentity;
async function driveFixture(){
 if(!testIdentity)testIdentity=(async()=>{
  const key=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const der=await crypto.subtle.exportKey('pkcs8',key.privateKey);
  return {key,secret:JSON.stringify({type:'service_account',client_email:'test@example.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\n'+Buffer.from(der).toString('base64')+'\n-----END PRIVATE KEY-----'})};
 })();
 const identity=await testIdentity,f=fake(),githubFetch=f.fetch;
 f.driveCalls=[];f.bytes=new TextEncoder().encode('%PDF-1.4\nDrive private\n%%EOF');f.shared=false;f.folderShared=false;f.wrongFolder=false;f.missing=false;f.tokenFail=false;
 f.fetch=async function(url,options={}){
  assert.equal(this,globalThis);
  const u=new URL(url);if(u.hostname==='api.github.com')return githubFetch(url,options);
  f.driveCalls.push({url,options});
  if(u.hostname==='oauth2.googleapis.com'){
   const assertion=new URLSearchParams(options.body).get('assertion'),[h,c,s]=assertion.split('.');
   assert.equal(JSON.parse(Buffer.from(c,'base64url')).scope,'https://www.googleapis.com/auth/drive.readonly');
   assert(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',identity.key.publicKey,Buffer.from(s,'base64url'),new TextEncoder().encode(h+'.'+c)));
   return f.tokenFail?new Response('',{status:401}):Response.json({access_token:'TEST_ONLY_TOKEN'});
  }
  assert.equal(u.hostname,'www.googleapis.com');assert.equal(options.method,undefined);assert.equal(options.redirect,'manual');
  assert.equal(options.headers.Authorization,'Bearer TEST_ONLY_TOKEN');
  if(f.missing)return new Response('',{status:404});
  if(u.pathname.endsWith('/permissions'))return Response.json({permissions:[{type:(u.pathname.includes(testFolder)?f.folderShared:f.shared)?'anyone':'user'}]});
  if(u.searchParams.get('alt')==='media')return new Response(f.bytes);
  const folder=u.pathname.endsWith(testFolder);
  return Response.json(folder?{id:testFolder,mimeType:'application/vnd.google-apps.folder',trashed:false}:{id:testDriveId,name:'部誌PDF.pdf',mimeType:'application/pdf',parents:[f.wrongFolder?'another-folder':testFolder],size:String(f.bytes.length),trashed:false});
 };
 const settings={DRIVE_FOLDER_ID:testFolder,DRIVE_SERVICE_ACCOUNT_JSON:identity.secret};
 const admin=await client(f,'admin',settings);
 const link=(x={})=>admin.request('/api/admin/works/work-4/drive-pdf','PUT',{file:'https://drive.google.com/file/d/'+testDriveId+'/view',member_status:'published',search_text:'友情',...x});
 return {f,settings,admin,link};
}
test('Drive URL parser accepts file URLs and IDs, rejects folders and external origins',()=>{
 assert.equal(driveFileId(testDriveId),testDriveId);assert.equal(driveFileId('https://drive.google.com/open?id='+testDriveId),testDriveId);
 for(const url of ['https://drive.google.com/drive/folders/'+testFolder,'https://evil.example/file/d/'+testDriveId,'https://drive.google.com.evil.example/file/d/'+testDriveId])assert.throws(()=>driveFileId(url),HttpError);
});
test('Drive link commits metadata atomically, private delivery works, unlink retains Drive original',async()=>{
 const {f,settings,admin,link}=await driveFixture();assert.equal((await link()).status,200);
 const w=f.state().works.find(w=>w.id==='work-4');assert(w.pdf_drive);assert.equal(w.pdf_key,null);assert.equal(w.pdf_bytes,0);
 const member=await client(f,'member',settings),r=await member.request('/api/member/works/work-4/pdf');assert.equal(r.status,200);assert.deepEqual(r.data,f.bytes);assert.equal(r.response.headers.get('Cache-Control'),'private, no-store');
 const results=await member.request('/api/member/works?q='+encodeURIComponent('友情'));assert.equal(results.data.items.length,1);assert(!JSON.stringify(results.data).includes(testDriveId));
 const count=f.driveCalls.length,guest=await client(f,null,settings);assert.equal((await guest.request('/api/member/works/work-4/pdf')).status,401);assert.equal((await member.request('/api/admin/works/work-4/drive-pdf','PUT',{})).status,403);assert.equal(f.driveCalls.length,count);
 assert.equal((await admin.request('/api/admin/works/work-4/drive-pdf','DELETE',{member_status:'draft',search_text:'友情'})).status,200);
 assert.equal(f.state().works.find(w=>w.id==='work-4').member_status,'draft');assert.equal(f.driveCalls.length,count);assert.equal((await member.request('/api/member/works/work-4/pdf')).status,404);
});
test('Drive rejects public permissions, folder escape, lost access and failed auth without changing GitHub',async()=>{
 for(const flag of ['shared','folderShared','wrongFolder','missing','tokenFail']){
  const {f,link}=await driveFixture(),head=f.head;f[flag]=true;assert.notEqual((await link()).status,200);assert.equal(f.head,head,flag);
 }
});
test('Drive content updates require re-link; public sharing and moving out block already linked PDF delivery',async()=>{
 const {f,settings,link}=await driveFixture();await link();const member=await client(f,'member',settings);
 f.bytes=new TextEncoder().encode('%PDF-1.4\nnew edited Drive PDF\n%%EOF');assert.equal((await member.request('/api/member/works/work-4/pdf')).status,409);
 assert.equal((await link()).status,200);assert.equal((await member.request('/api/member/works/work-4/pdf')).status,200);
 f.shared=true;assert.equal((await member.request('/api/member/works/work-4/pdf')).status,503);f.shared=false;f.wrongFolder=true;assert.equal((await member.request('/api/member/works/work-4/pdf')).status,400);
});
test('Drive rejects oversize PDF, stale revision before Drive access, and concurrent commit without lost writes',async()=>{
 const a=await driveFixture();a.f.bytes=new Uint8Array(MAX_PDF+1);assert.equal((await a.link()).status,413);assert.equal(a.f.head,'head0');
 const b=await driveFixture();b.admin.setRevision('stale');assert.equal((await b.link()).status,409);assert.equal(b.f.driveCalls.length,0);
 const c=await driveFixture();c.f.race=true;assert.equal((await c.link()).status,409);assert.equal(c.f.head,'concurrent');assert(!c.f.state().works.find(w=>w.id==='work-4').pdf_drive);
});
test('Legacy GitHub PDFs still read in Drive mode; failed migration preserves original and successful link keeps archival blob',async()=>{
 const {f,settings,admin,link}=await driveFixture(),legacy=await client(f);
 await legacy.request('/api/admin/works/work-4/pdf','PUT',new TextEncoder().encode('%PDF-1.4 old'));
 await legacy.request('/api/admin/works/work-4','PUT',{member_status:'published',search_text:''});
 const old=f.state().works.find(w=>w.id==='work-4').pdf_key;
 const member=await client(f,'member',settings);assert.equal((await member.request('/api/member/works/work-4/pdf')).status,200);
 admin.setRevision(f.head);f.shared=true;assert.equal((await link()).status,503);assert.equal(f.state().works.find(w=>w.id==='work-4').pdf_key,old);
 f.shared=false;assert.equal((await link()).status,200);assert(f.trees.get(f.commits.get(f.head).tree).has(old));
 assert.equal((await admin.request('/api/admin/works/work-4/pdf','PUT',new TextEncoder().encode('%PDF-1.4'))).status,400);
 const before=f.driveCalls.length;assert.equal((await admin.request('/api/admin/works/work-4','DELETE')).status,200);assert.equal(f.driveCalls.length,before);
});
