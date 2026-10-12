const $=id=>document.getElementById(id);
const labels={introduction:'作品紹介',issue:'部誌',message:'部員のひとこと',event:'イベント',store:'冊子設置先',notice:'お知らせ',page:'活動紹介'};
const fieldLabels={title:'見出し・名称',workId:'対象作品',author:'掲載名',body:'本文・紹介文',excerpt:'一般公開する短い抜粋',number:'号数',date:'日付・期間',description:'紹介文',contents:'目次（作品名・作者・ページを一行ずつ）',role:'役職',place:'会場',url:'案内URL',address:'住所',issues:'取り扱い部誌（一行ずつ）'};
const fields={introduction:['title','workId','author','body','excerpt'],issue:['title','number','date','description','contents'],message:['title','role','author','body'],event:['title','date','place','body','url'],store:['title','address','body','url','issues'],notice:['title','date','body'],page:['title','body']};
const demo=new URLSearchParams(location.search).has('demo');
let role='guest',pendingRole='member',entries=[],authors=[],works=[];
function status(message){$('status').textContent=message;}
async function api(path,options={}){
 if(demo)return demoApi(path,options);
 const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});
 const data=await response.json();if(!response.ok)throw new Error(data.error||'処理を完了できません');return data;
}
// Explicit design preview: fictional data, memory only, no passwords, no persistence.
async function demoApi(path,options){
 const x=options.body?JSON.parse(options.body):{};
 if(path==='/api/status')return {database:false,storage:false,auth:false};
 if(path==='/api/session')return {role};
 if(path==='/api/logout'){role='guest';return {};}
 if(path==='/api/login'){role=x.role;return {role};}
 if(path.startsWith('/api/public/entries'))return {items:entries.filter(e=>e.published).map(e=>({id:e.id,kind:e.kind,content:e.published}))};
 if(path.startsWith('/api/member/works'))return {items:[]};
 if(path==='/api/admin/authors'){if(options.method==='POST'){authors.push({id:crypto.randomUUID(),...x});return {};}return {items:authors};}
 if(path==='/api/admin/works'){if(options.method==='POST'){works.push({id:crypto.randomUUID(),...x});return {};}return {items:works};}
 if(path==='/api/admin/entries' && options.method==='POST'){const id=crypto.randomUUID();entries.push({id,kind:x.kind,draft:x.content,published:null,version:1});return {id};}
 if(path==='/api/admin/entries')return {items:entries};
 const e=entries.find(e=>path.endsWith('/'+e.id));if(!e)throw new Error('見つかりません');
 if(e.version!==Number(x.version))throw new Error('一覧を再読み込みしてください');
 e.draft=x.content;e.version++;if(x.action==='publish')e.published=structuredClone(x.content);if(x.action==='unpublish')e.published=null;return {};
}
function element(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function renderContent(kind,c){
 const card=element('article',undefined,'card');card.append(element('p',labels[kind],'eyebrow'),element('h2',c.title));
 for(const field of fields[kind].filter(x=>!['title','workId'].includes(x))){if(!c[field])continue;if(field==='url'){try{const url=new URL(c[field]);if(['https:','http:'].includes(url.protocol)){const a=element('a','案内ページへ →');a.href=url.href;a.rel='noopener noreferrer';card.append(a);}}catch{}}else card.append(element('p',c[field]));}
 return card;
}
async function show(view){
 ['public','login','member','admin'].forEach(v=>$(v+'-view').hidden=true);
 $('logout').hidden=role==='guest';status('');
 if(view==='admin' && role!=='admin' || view==='member' && role==='guest'){
  pendingRole=view==='admin'?'admin':'member';$('login-title').textContent=pendingRole==='admin'?'管理者ログイン':'会員ログイン';$('login-view').hidden=false;return;
 }
 $(view+'-view').hidden=false;
 try{if(view==='public')await loadPublic();if(view==='member')await loadMember();if(view==='admin')await loadAdmin();}catch(e){status(e.message);}
}
async function loadPublic(){
 const {items}=await api('/api/public/entries');const q=$('public-search').value.normalize('NFKC').toLocaleLowerCase('ja'),kind=$('public-kind').value;
 const found=items.filter(e=>(!kind||e.kind===kind)&&Object.values(e.content).join(' ').normalize('NFKC').toLocaleLowerCase('ja').includes(q));
 $('public-list').replaceChildren(...found.map(e=>renderContent(e.kind,e.content)));if(!found.length)$('public-list').append(element('p','公開済みの情報がありません。'));
}
async function loadMember(){
 const q=new FormData($('member-search')).get('q')||'';
 const {items}=await api('/api/member/works?q='+encodeURIComponent(q));
 $('member-list').replaceChildren(...items.map(w=>{const card=element('article',undefined,'card');card.append(element('h2',w.title),element('p',w.author));if(w.hasPdf){const a=element('a','PDFを閲覧する →');a.href='/api/member/works/'+encodeURIComponent(w.id)+'/pdf';a.target='_blank';a.rel='noopener';card.append(a);}return card;}));
 if(!items.length)$('member-list').append(element('p','条件に合う会員公開済み作品がありません。'));
}
async function loadAdmin(){
 const result=await Promise.all([api('/api/admin/entries'),api('/api/admin/authors'),api('/api/admin/works')]);entries=result[0].items;authors=result[1].items;works=result[2].items;renderEntries();
 const select=$('work-form').elements.author_id;select.replaceChildren(element('option','作者を選択'));select.firstChild.value='';authors.forEach(a=>{const o=element('option',a.label+' ／ '+a.id);o.value=a.id;select.append(o);});
}
function renderEntries(){
 const filtered=entries.filter(e=>!$('admin-kind').value||e.kind===$('admin-kind').value);
 $('admin-list').replaceChildren(...filtered.map(e=>{const b=element('button',e.draft.title,'entry-button');b.append(element('small',labels[e.kind]+' ／ '+(e.published?'公開中':'下書き')));b.onclick=()=>edit(e);return b;}));
}
function edit(entry){
 $('author-form').hidden=$('work-form').hidden=true;$('entry-form').hidden=false;$('editor-empty').hidden=true;$('preview').hidden=true;
 const f=$('entry-form');f.elements.id.value=entry?.id||'';f.elements.version.value=entry?.version||'';if(entry)f.elements.kind.value=entry.kind;f.elements.kind.disabled=!!entry;renderFields(entry?.draft||{});
}
function renderFields(content){
 const kind=$('editor-kind').value;
 $('editor-fields').replaceChildren(...fields[kind].map(field=>{
  const label=element('label',fieldLabels[field]);let input;
  if(field==='role'||field==='workId'){input=element('select');const choices=field==='role'?['部長','副部長','メンバー'].map(x=>({value:x,label:x})):[{value:'',label:'作品を選択'},...works.map(w=>({value:w.id,label:w.title+' ／ '+w.credited_name}))];choices.forEach(x=>{const o=element('option',x.label);o.value=x.value;input.append(o);});}
  else input=element(['body','excerpt','description','contents','issues'].includes(field)?'textarea':'input');
  input.name=field;input.value=content[field]||'';if(['title','workId','role'].includes(field))input.required=true;if(field==='title')input.maxLength=200;else if(input.tagName!=='SELECT')input.maxLength=20000;label.append(input);return label;
 }));
}
function formContent(){const values=new FormData($('entry-form'));const c={};for(const field of fields[$('editor-kind').value])c[field]=String(values.get(field)||'');return c;}
for(const [kind,label] of Object.entries(labels)){for(const id of ['editor-kind','admin-kind']){const o=element('option',label);o.value=kind;$(id).append(o);}}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>show(b.dataset.view));
$('public-search').oninput=()=>loadPublic().catch(e=>status(e.message));$('public-kind').onchange=$('public-search').oninput;
$('admin-kind').onchange=renderEntries;$('editor-kind').onchange=()=>renderFields({});
$('new-entry').onclick=()=>edit(null);$('reload').onclick=()=>loadAdmin().catch(e=>status(e.message));
$('new-author').onclick=()=>{$('author-form').hidden=false;$('work-form').hidden=true;};
$('new-work').onclick=()=>{$('work-form').hidden=false;$('author-form').hidden=true;};
$('preview-button').onclick=()=>{$('preview-body').replaceChildren(renderContent($('editor-kind').value,formContent()));$('preview').hidden=false;};
$('login-form').onsubmit=async event=>{event.preventDefault();try{const x=await api('/api/login',{method:'POST',body:JSON.stringify({role:pendingRole,password:new FormData(event.target).get('password')})});role=x.role;event.target.reset();await show(role==='admin'?'admin':'member');}catch(e){status(e.message);}};
$('logout').onclick=async()=>{try{await api('/api/logout',{method:'POST',body:'{}'});role='guest';entries=[];authors=[];works=[];$('entry-form').reset();$('entry-form').hidden=true;$('preview-body').replaceChildren();$('admin-list').replaceChildren();$('member-list').replaceChildren();await show('public');}catch(e){status(e.message);}};
$('member-search').onsubmit=event=>{event.preventDefault();loadMember().catch(e=>status(e.message));};
for(const [id,path] of [['author-form','authors'],['work-form','works']])$(id).onsubmit=async event=>{event.preventDefault();try{await api('/api/admin/'+path,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});event.target.reset();event.target.hidden=true;await loadAdmin();status('保存しました。');}catch(e){status(e.message);}};
$('entry-form').onsubmit=async event=>{
 event.preventDefault();const f=event.target,action=event.submitter?.value||'save',kind=$('editor-kind').value;
 if(action==='publish'&&!confirm('この内容を一般公開しますか？'))return;
 if(action==='unpublish'&&!confirm('一般公開を取り下げますか？'))return;
 const buttons=[...f.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{
  let id=f.elements.id.value,version=Number(f.elements.version.value);const content=formContent();
  if(!id){const x=await api('/api/admin/entries',{method:'POST',body:JSON.stringify({kind,content})});id=x.id;version=1;}
  await api('/api/admin/entries/'+id,{method:'PUT',body:JSON.stringify({action,content,version})});
  await loadAdmin();edit(entries.find(e=>e.id===id));status(action==='publish'?'公開しました。':action==='unpublish'?'公開を取り下げました。':'下書きを保存しました。');
 }catch(e){status(e.message);}finally{buttons.forEach(b=>b.disabled=false);}
};
if(demo){
 $('banner').hidden=false;$('banner').textContent='画面確認用デモです。入力はこのタブのメモリ内だけで、再読み込みすると消えます。実際のログイン・DB保存・PDF登録は行いません。デモでは任意の入力で画面を確認できます。';
 entries=[{id:'sample',kind:'message',version:1,draft:{title:'部長からのご挨拶（架空の例）',role:'部長',author:'サンプル',body:'読むことも、書くことも。それぞれの言葉を大切にする場所へ。'},published:{title:'部長からのご挨拶（架空の例）',role:'部長',author:'サンプル',body:'読むことも、書くことも。それぞれの言葉を大切にする場所へ。'}}];
}
try{role=(await api('/api/session')).role;const config=await api('/api/status');if(!demo&&(!config.database||!config.auth)){$('banner').hidden=false;$('banner').textContent='初期設定待ちです。データベース・認証の接続後に利用できます。';}await show('public');}catch(e){status(e.message);}
