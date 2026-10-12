import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{route} from '../server/worker.mjs';
import {issueSession,cookie,session} from '../server/auth.mjs';
import {validateContent,publicEntry} from '../server/model.mjs';
const env={MEMBER_PASSWORD:'reader-test-only-long-password',ADMIN_PASSWORD:'admin-test-only-long-password',SESSION_SECRET:'test-only-session-secret-at-least-32-characters'};
const req=(path,options={})=>new Request('https://club.example'+path,options);
test('missing infrastructure returns explicit setup state, never grants login',async()=>{
 const r=await worker.fetch(req('/api/login',{method:'POST',headers:{Origin:'https://club.example'},body:JSON.stringify({role:'admin',password:'x'})}),{});
 assert.equal(r.status,503);
 assert.equal((await (await route(req('/api/status'),{})).json()).pdfUpload,false);
});
test('unsigned and tampered sessions cannot access management',async()=>{
 const token=await issueSession('admin',env);
 assert.equal(await session(req('/api/session',{headers:{Cookie:cookie(token+'x')}}),env),null);
 assert.equal((await route(req('/api/admin/entries'),env)).status,403);
});
test('member session cannot act as administrator',async()=>{
 const token=await issueSession('member',env);
 assert.equal((await session(req('/api/session',{headers:{Cookie:cookie(token)}}),env)).role,'member');
 assert.equal((await route(req('/api/admin/entries',{headers:{Cookie:cookie(token)}}),env)).status,403);
});
test('password rotation invalidates old sessions',async()=>{
 const token=await issueSession('member',env);
 assert.equal(await session(req('/api/session',{headers:{Cookie:cookie(token)}}),{...env,MEMBER_PASSWORD:'changed-password-at-least-16'}),null);
});
test('foreign origins cannot submit changes',async()=>{
 const token=await issueSession('admin',env);
 const r=await route(req('/api/admin/entries',{method:'POST',headers:{Cookie:cookie(token),Origin:'https://evil.example'},body:'{}'}),env);
 assert.equal(r.status,403);
});
test('public projection returns published snapshot and strips private fields',()=>{
 const x=publicEntry({id:'entry',kind:'introduction',draft_json:'{"title":"secret draft"}',published_json:JSON.stringify({title:'公開',workId:'work',body:'紹介',search_text:'SECRET FULL TEXT',pdf_key:'private/file.pdf',password:'secret'})});
 assert.equal(x.content.title,'公開');
 assert.equal(JSON.stringify(x).includes('SECRET'),false);
 assert.equal('pdf_key' in x.content,false);
 assert.equal(publicEntry({published_json:null}),null);
 assert.throws(()=>validateContent('event',{title:'x',url:'javascript:alert(1)'}));
});
test('member search never returns full search text or internal PDF keys',async()=>{
 const token=await issueSession('member',env);
 const db={prepare(){return {async all(){return {results:[{id:'work',title:'物語',credited_name:'作者',search_text:'秘密の本文',pdf_key:'private/key'}]};}};}};
 const r=await route(req('/api/member/works?q='+encodeURIComponent('秘密'),{headers:{Cookie:cookie(token)}}),{...env,DB:db});
 const output=await r.json();assert.equal(output.items.length,1);assert.equal('search_text' in output.items[0],false);assert.equal('pdf_key' in output.items[0],false);
});
test('database errors do not expose exception details',async()=>{
 const r=await worker.fetch(req('/api/public/entries'),{DB:{prepare(){throw new Error('secret database information');}}});
 assert.equal(r.status,500);assert.equal((await r.text()).includes('secret'),false);
});
