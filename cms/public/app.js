const $=id=>document.getElementById(id);
const labels={introduction:'作品紹介',issue:'部誌',message:'部員のひとこと',event:'イベント',store:'冊子設置先',notice:'お知らせ',page:'活動紹介（ホーム掲載）'};
const fieldLabels={title:'見出し・名称',workId:'対象作品',author:'掲載名',body:'本文・紹介文',excerpt:'一般公開する短い抜粋',number:'号数',date:'日付・期間',description:'紹介文',contents:'目次（作品名・作者・ページを一行ずつ）',role:'役職',place:'会場',url:'案内URL',address:'住所',issues:'取り扱い部誌（一行ずつ）'};
const fields={introduction:['title','workId','author','body','excerpt'],issue:['title','number','date','description','contents','cover'],message:['title','role','author','body'],event:['title','date','place','body','url'],store:['title','address','body','url','issues'],notice:['title','date','body'],page:['title','body']};
let demo=new URLSearchParams(location.search).has('demo');
let localServer=false,githubServer=false,recordsEnabled=false,pdfEnabled=false,maxPdfBytes=50000000,revision='',busy=false;
let driveMode=false;
let coverPreviewUrl='';
let role='guest',pendingRole='member',entries=[],authors=[],works=[];
function status(message){$('status').textContent=message;}
async function api(path,options={}){
 if(demo)return demoApi(path,options);
 const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(githubServer&&revision&&options.method?{'X-CMS-Revision':revision}:{}),...options.headers}});
 const data=await response.json();if(!response.ok)throw new Error(data.error||'処理を完了できません');if(githubServer&&data.revision&&(options.method||path==='/api/admin/snapshot'))revision=data.revision;return data;
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
 if(kind==='issue'&&(coverPreviewUrl||c.cover)){const image=element('img');image.src=coverPreviewUrl||'/api/admin/entries/'+encodeURIComponent($('entry-form').elements.id.value)+'/cover?hash='+c.cover;image.alt=c.title+'の表紙';image.style.maxWidth='100%';image.style.maxHeight='300px';card.append(image);}
 for(const field of fields[kind].filter(x=>!['title','workId','cover'].includes(x))){if(!c[field])continue;if(field==='url'){try{const url=new URL(c[field]);if(['https:','http:'].includes(url.protocol)){const a=element('a','案内ページへ →');a.href=url.href;a.rel='noopener noreferrer';card.append(a);}}catch{}}else card.append(element('p',c[field]));}
 return card;
}
async function show(view){
 ['login','member','admin'].forEach(v=>$(v+'-view').hidden=true);
 $('logout').hidden=role==='guest';$('member-nav').hidden=role==='guest';status('');
 if(view==='admin' && role==='guest')view='member';
 if(view==='admin' && role!=='admin' || view==='member' && role==='guest'){
  pendingRole=view==='admin'?'admin':'member';$('login-title').textContent=pendingRole==='admin'?'管理者ログイン':'部員ログイン';$('login-view').hidden=false;return;
 }
 $(view+'-view').hidden=false;
 try{if(view==='member')await loadMember();if(view==='admin')await loadAdmin();}catch(e){status(e.message);}
}
async function loadMember(){
 const q=new FormData($('member-search')).get('q')||'';
 const {items}=await api('/api/member/works?q='+encodeURIComponent(q));
 $('member-list').replaceChildren(...items.map(w=>{const card=element('article',undefined,'card');card.append(element('h2',w.title),element('p',w.author));if(w.hasPdf){const a=element('a','PDFを閲覧する →');a.href='/api/member/works/'+encodeURIComponent(w.id)+'/pdf';a.target='_blank';a.rel='noopener';card.append(a);}return card;}));
 if(!items.length)$('member-list').append(element('p','条件に合う会員公開済み作品がありません。'));
}
async function loadAdmin(){
 if(githubServer){const x=await api('/api/admin/snapshot');entries=x.entries;authors=x.authors;works=x.works;}else{const result=await Promise.all([api('/api/admin/entries'),api('/api/admin/authors'),api('/api/admin/works')]);entries=result[0].items;authors=result[1].items;works=result[2].items;}renderEntries();
 const select=$('work-form').elements.author_id;select.replaceChildren(element('option','作者を選択'));select.firstChild.value='';authors.forEach(a=>{const o=element('option',a.label+' ／ '+a.id);o.value=a.id;select.append(o);});
 const pdfSelect=$('pdf-form').elements.work_id;pdfSelect.replaceChildren(element('option','作品を選択'));pdfSelect.firstChild.value='';works.forEach(w=>{const o=element('option',w.title+' ／ '+w.credited_name);o.value=w.id;pdfSelect.append(o);});
 $('pdf-tools').hidden=!pdfEnabled;$('records-tools').hidden=!recordsEnabled;
 if(recordsEnabled)renderRecords();
}
function renderEntries(){
 const filtered=entries.filter(e=>!$('admin-kind').value||e.kind===$('admin-kind').value);
 $('admin-list').replaceChildren(...filtered.map(e=>{const b=element('button',e.draft.title,'entry-button');b.append(element('small',labels[e.kind]+' ／ '+(e.published?'公開中':'下書き')));b.onclick=()=>edit(e);return b;}));
}
function edit(entry){
 $('author-form').hidden=$('work-form').hidden=true;$('entry-form').hidden=false;$('editor-empty').hidden=true;$('preview').hidden=true;
 $('delete-entry').hidden=!recordsEnabled||!entry;
 const f=$('entry-form');f.elements.id.value=entry?.id||'';f.elements.version.value=entry?.version||'';if(entry)f.elements.kind.value=entry.kind;f.elements.kind.disabled=!!entry;renderFields(entry?.draft||{});
}
function renderFields(content){
 const kind=$('editor-kind').value;
 if(coverPreviewUrl){URL.revokeObjectURL(coverPreviewUrl);coverPreviewUrl='';}
 $('editor-fields').replaceChildren(...fields[kind].filter(field=>field!=='cover').map(field=>{
  const label=element('label',fieldLabels[field]);let input;
  if(field==='role'||field==='workId'){input=element('select');const choices=field==='role'?['部長','副部長','メンバー'].map(x=>({value:x,label:x})):[{value:'',label:'作品を選択'},...works.map(w=>({value:w.id,label:w.title+' ／ '+w.credited_name}))];choices.forEach(x=>{const o=element('option',x.label);o.value=x.value;input.append(o);});}
  else input=element(['body','excerpt','description','contents','issues'].includes(field)?'textarea':'input');
  input.name=field;input.value=content[field]||'';if(['title','workId','role'].includes(field))input.required=true;if(field==='title')input.maxLength=200;else if(input.tagName!=='SELECT')input.maxLength=20000;label.append(input);return label;
 }));
 if(kind==='issue'){
  const hidden=element('input');hidden.type='hidden';hidden.name='cover';hidden.value=content.cover||'';$('editor-fields').append(hidden);
  if(githubServer){
   const label=element('label','表紙画像（JPEG・PNG・WebP／選択後に保存・公開してください）'),file=element('input');file.type='file';file.name='_cover_file';file.accept='image/jpeg,image/png,image/webp';
   const image=element('img');image.alt='表紙画像の確認';image.style.maxWidth='100%';image.style.maxHeight='280px';image.hidden=!content.cover;
   if(content.cover)image.src='/api/admin/entries/'+encodeURIComponent($('entry-form').elements.id.value)+'/cover?hash='+content.cover;
   file.onchange=()=>{if(coverPreviewUrl)URL.revokeObjectURL(coverPreviewUrl);coverPreviewUrl='';const selected=file.files[0];if(selected){if(!['image/jpeg','image/png','image/webp'].includes(selected.type)||selected.size>10000000){file.value='';status('表紙はJPEG・PNG・WebPの10MB以内を選択してください');return;}coverPreviewUrl=URL.createObjectURL(selected);image.src=coverPreviewUrl;image.hidden=false;}};
   label.append(file);$('editor-fields').append(label,element('p','画像はブラウザで縮小し、1MB以内のJPEGとして保存します。下書き保存では一般公開されません。','note'),image);
   const remove=element('button','表紙を外す');remove.type='button';remove.onclick=()=>{hidden.value='';file.value='';image.hidden=true;if(coverPreviewUrl)URL.revokeObjectURL(coverPreviewUrl);coverPreviewUrl='';};$('editor-fields').append(remove);
  }
 }
}
async function prepareCover(file){
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10000000)throw Error('表紙画像はJPEG・PNG・WebPの10MB以内にしてください');
 const source=URL.createObjectURL(file),image=new Image();
 try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('画像を読み込めませんでした'));image.src=source;});
  if(!image.naturalWidth||image.naturalWidth*image.naturalHeight>40000000)throw Error('画像が大きすぎます。縮小した画像を選択してください');
  const ratio=Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
  const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
  for(const quality of [.85,.65,.45]){const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));if(blob&&blob.size<=1000000)return blob;}
  throw Error('画像を1MB以内に縮小できませんでした。小さい画像を選択してください');
 }finally{URL.revokeObjectURL(source);}
}
function formContent(){const values=new FormData($('entry-form'));const c={};for(const field of fields[$('editor-kind').value])c[field]=String(values.get(field)||'');return c;}
for(const [kind,label] of Object.entries(labels)){for(const id of ['editor-kind','admin-kind']){const o=element('option',label);o.value=kind;$(id).append(o);}}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>show(b.dataset.view));
$('admin-kind').onchange=renderEntries;$('editor-kind').onchange=()=>renderFields({});
$('new-entry').onclick=()=>edit(null);$('reload').onclick=()=>{if(!confirm('編集中の入力を閉じ、最新の一覧を読み込みますか？'))return;for(const id of ['entry-form','work-form','author-form','preview'])$(id).hidden=true;loadAdmin().catch(e=>status(e.message));};
$('new-author').onclick=()=>{editAuthor(null);};
$('new-work').onclick=()=>{editWork(null);};
$('preview-button').onclick=()=>{$('preview-body').replaceChildren(renderContent($('editor-kind').value,formContent()));$('preview').hidden=false;};
$('login-form').onsubmit=async event=>{event.preventDefault();try{const x=await api('/api/login',{method:'POST',body:JSON.stringify({role:pendingRole,password:new FormData(event.target).get('password')})});role=x.role;event.target.reset();await show(role==='admin'?'admin':'member');}catch(e){status(e.message);}};
$('logout').onclick=async()=>{try{await api('/api/logout',{method:'POST',body:'{}'});role='guest';entries=[];authors=[];works=[];revision='';$('entry-form').reset();$('entry-form').hidden=true;$('preview-body').replaceChildren();$('admin-list').replaceChildren();$('member-list').replaceChildren();await show('member');}catch(e){status(e.message);}};
$('member-search').onsubmit=event=>{event.preventDefault();loadMember().catch(e=>status(e.message));};
for(const [id,path] of [['author-form','authors'],['work-form','works']])$(id).onsubmit=async event=>{event.preventDefault();try{const x=Object.fromEntries(new FormData(event.target)),key=x.id;delete x.id;await api('/api/admin/'+path+(key?'/'+encodeURIComponent(key):''),{method:key?'PUT':'POST',body:JSON.stringify(x)});event.target.reset();event.target.hidden=true;await loadAdmin();status('保存しました。');}catch(e){status(e.message);}};
$('entry-form').onsubmit=async event=>{
 event.preventDefault();const f=event.target,action=event.submitter?.value||'save',kind=$('editor-kind').value;
 if(action==='publish'&&!confirm('この内容を一般公開しますか？'))return;
 if(action==='unpublish'&&!confirm('一般公開を取り下げますか？'))return;
 const buttons=[...f.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{
  let id=f.elements.id.value,version=Number(f.elements.version.value);const content=formContent();
  const coverFile=kind==='issue'?f.querySelector('[name="_cover_file"]')?.files[0]:null;
  const coverBlob=coverFile?await prepareCover(coverFile):null;
  if(!id){const x=await api('/api/admin/entries',{method:'POST',body:JSON.stringify({kind,content})});id=x.id;version=1;f.elements.id.value=id;f.elements.version.value=version;}
  if(coverBlob){const x=await api('/api/admin/entries/'+encodeURIComponent(id)+'/cover',{method:'PUT',headers:{'Content-Type':'image/jpeg'},body:coverBlob});content.cover=x.cover;version=x.version;f.elements.version.value=version;f.elements.cover.value=x.cover;f.querySelector('[name="_cover_file"]').value='';}
  await api('/api/admin/entries/'+id,{method:'PUT',body:JSON.stringify({action,content,version})});
  await loadAdmin();edit(entries.find(e=>e.id===id));status(action==='publish'?'公開しました。':action==='unpublish'?'公開を取り下げました。':'下書きを保存しました。');
 }catch(e){status(e.message);}finally{buttons.forEach(b=>b.disabled=false);}
};
$('pdf-form').elements.work_id.onchange=()=>{const w=works.find(w=>w.id===$('pdf-form').elements.work_id.value);$('pdf-form').elements.search_text.value=w?.search_text||'';$('pdf-form').elements.member_status.value=w?.member_status||'draft';if(driveMode){$('drive-file').value='';$('drive-current').textContent=w?.pdf_drive?'現在のPDF：'+w.pdf_drive.name+'（Drive）。差し替え・Driveでの内容更新後はURLを入力し直してください。':w?.pdf_key?'現在のPDF：GitHub保存。移行する場合はDriveにコピーし、そのPDFのURLを入力してください。':'PDFは未登録です。';$('drive-unlink').disabled=!w?.pdf_drive;}};
$('pdf-form').onsubmit=async event=>{event.preventDefault();const f=event.target;try{const id=f.elements.work_id.value;if(!id)throw Error('作品を選択してください');const file=f.elements.pdf.files[0];if(file){if(file.size>maxPdfBytes)throw Error('PDFは'+Math.floor(maxPdfBytes/1000000)+'MB以内です');const r=await fetch('/api/admin/works/'+encodeURIComponent(id)+'/pdf',{method:'PUT',body:file,headers:{'Content-Type':'application/pdf',...(githubServer&&revision?{'X-CMS-Revision':revision}:{})}});const data=await r.json();if(!r.ok)throw Error(data.error);if(data.revision)revision=data.revision;f.elements.pdf.value='';}
await api('/api/admin/works/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify({member_status:f.elements.member_status.value,search_text:f.elements.search_text.value})});await loadAdmin();status('PDF・会員公開状態を保存しました。');f.elements.pdf.value='';}catch(e){status(e.message);}};
function configureDrive(info){
 if(info.pdfBackend!=='drive')return;
 driveMode=true;const f=$('pdf-form'),originalNote=f.querySelector('p.note');f.elements.pdf.closest('label').hidden=true;f.elements.pdf.disabled=true;
 const section=element('div');
 section.append(element('p','PDFは専用のDriveフォルダへアップロードしてください。ファイルの共有は「制限付き」のままにし、そのPDFのURLを下の欄へ入力します。サイトからDriveのファイルを削除することはありません。','note'));
 if(!info.driveReady)section.append(element('p','Driveの接続設定が未完了です。関連付けは設定完了後に利用できます。','banner'));
 const label=element('label','DriveのPDFのURL（登録・差し替え時のみ）'),input=element('input');input.id='drive-file';input.type='text';input.maxLength=500;input.placeholder='https://drive.google.com/file/d/…/view';label.append(input);
 const current=element('p','作品を選ぶと現在のPDFを表示します。','note');current.id='drive-current';
 const unlink=element('button','DriveのPDFの掲載を解除');unlink.id='drive-unlink';unlink.type='button';unlink.disabled=true;
 section.append(label,current,unlink);f.elements.work_id.closest('label').after(section);
 f.elements.search_text.closest('label').firstChild.textContent='検索キーワード（作者名・作品名は自動で検索対象になります）';
 f.elements.search_text.placeholder='例：青春 友情 再会 短編';
 originalNote.textContent='全文の入力は不要です。PDFは専用フォルダ直下・1ファイル10MB以内。Drive側で本文を変更した場合は、同じURLでも関連付けを再登録してください。';
 const buttons=()=>[...f.querySelectorAll('button')];
 const finish=async(id,message)=>{await loadAdmin();f.elements.work_id.value=id;f.elements.work_id.onchange();status(message);};
 f.onsubmit=async event=>{
  event.preventDefault();if(busy)return;busy=true;buttons().forEach(b=>b.disabled=true);
  try{
   const id=f.elements.work_id.value,w=works.find(w=>w.id===id);if(!w)throw Error('作品を選択してください');
   const x={member_status:f.elements.member_status.value,search_text:f.elements.search_text.value},file=input.value.trim();
   if(x.search_text.length>10000)throw Error('検索キーワードは1万文字以内にしてください');
   if(x.member_status==='published'&&!confirm('このPDFを部員・卒業生に公開しますか？'))return;
   if(!file&&!w.pdf_drive&&!w.pdf_key)throw Error('DriveのPDFのURLを入力してください');
   status('保存しています。画面を閉じずにお待ちください。');
   if(file)await api('/api/admin/works/'+encodeURIComponent(id)+'/drive-pdf',{method:'PUT',body:JSON.stringify({...x,file})});
   else await api('/api/admin/works/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify(x)});
   await finish(id,'PDF・公開状態を保存しました。');
  }catch(e){status(e.message);}finally{busy=false;buttons().forEach(b=>b.disabled=false);const w=works.find(w=>w.id===f.elements.work_id.value);unlink.disabled=!w?.pdf_drive;}
 };
 unlink.onclick=async()=>{
  if(busy||!confirm('PDFの掲載を解除し、会員公開を下書きに戻します。Driveの原本は残ります。'))return;
  busy=true;buttons().forEach(b=>b.disabled=true);
  try{const id=f.elements.work_id.value;await api('/api/admin/works/'+encodeURIComponent(id)+'/drive-pdf',{method:'DELETE',body:JSON.stringify({member_status:'draft',search_text:f.elements.search_text.value})});await finish(id,'掲載を解除しました。Driveの原本は残っています。');}catch(e){status(e.message);}finally{busy=false;buttons().forEach(b=>b.disabled=false);unlink.disabled=!works.find(w=>w.id===f.elements.work_id.value)?.pdf_drive;}
 };
}
function editAuthor(author){$('entry-form').hidden=true;$('preview').hidden=true;const f=$('author-form');f.reset();f.hidden=false;$('work-form').hidden=true;f.elements.id.value=author?.id||'';f.elements.label.value=author?.label||'';f.elements.membership.value=author?.membership||'current';$('author-form-title').textContent=author?'作者を修正':'作者を登録';f.scrollIntoView({block:'center'});}
function editWork(work){$('entry-form').hidden=true;$('preview').hidden=true;const f=$('work-form');f.reset();f.hidden=false;$('author-form').hidden=true;f.elements.id.value=work?.id||'';f.elements.title.value=work?.title||'';f.elements.credited_name.value=work?.credited_name||'';f.elements.author_id.value=work?.author_id||'';$('work-form-title').textContent=work?'作品情報を修正':'作品を登録';f.scrollIntoView({block:'center'});}
function renderRecords(){
 for(const [id,list,type,edit] of [['work-records',works,'works',editWork],['author-records',authors,'authors',editAuthor]]){
  $(id).replaceChildren(...list.map(record=>{const card=element('div',undefined,'record');card.append(element('p',type==='works'?record.title+' ／ '+record.credited_name:record.label));const buttons=element('div',undefined,'toolbar');const modify=element('button','修正');modify.onclick=()=>edit(record);const remove=element('button','削除');remove.onclick=async()=>{const message=type==='works'?(record.pdf_drive?'この作品のサイト掲載と関連する作品紹介を削除します。Driveの原本は残ります。部誌目次は別途修正が必要です。':'この作品とPDF・関連する作品紹介を削除します。元に戻せません。部誌目次は別途修正が必要です。'):'この作者を削除します。作品が残っている作者は削除できません。';if(!confirm(message))return;try{const result=await api('/api/admin/'+type+'/'+encodeURIComponent(record.id),{method:'DELETE'});await loadAdmin();status(result.warning||'削除しました。');}catch(e){status(e.message);}};buttons.append(modify,remove);card.append(buttons);return card;}));
 }
}
$('delete-entry').onclick=async()=>{const f=$('entry-form');if(!f.elements.id.value||!confirm('この記事を削除します。公開ページからも消え、元に戻せません。'))return;try{await api('/api/admin/entries/'+encodeURIComponent(f.elements.id.value),{method:'DELETE',body:JSON.stringify({version:Number(f.elements.version.value)})});f.hidden=true;$('preview').hidden=true;await loadAdmin();status('削除しました。');}catch(e){status(e.message);}};
window.clubPortalReady=true;
try {const probe=await fetch('/api/status');if(probe.ok){const info=await probe.json();if(info.localDemo){demo=false;localServer=true;recordsEnabled=true;pdfEnabled=true;}if(info.backend==='github'){demo=false;githubServer=true;recordsEnabled=info.records;pdfEnabled=info.pdfUpload;maxPdfBytes=info.maxPdfBytes||10000000;configureDrive(info);}}}catch{}
if(localServer){$('banner').hidden=false;$('banner').textContent='PC内の保存付きデモです。部員: member-demo ／ 管理者: admin-demo。内容はこのPCだけに保存されます。';}
if(githubServer){$('pdf-limit').textContent='PDF（'+Math.floor(maxPdfBytes/1000000)+'MB以内・差し替え可）';}
if(demo){
 $('home-link').href='index.html?demo=1';
 $('banner').hidden=false;$('banner').textContent='画面確認用デモです。入力はこのタブのメモリ内だけで、再読み込みすると消えます。実際のログイン・DB保存・PDF登録は行いません。デモでは任意の入力で画面を確認できます。';
 entries=[{id:'sample',kind:'message',version:1,draft:{title:'部長からのご挨拶（架空の例）',role:'部長',author:'サンプル',body:'読むことも、書くことも。それぞれの言葉を大切にする場所へ。'},published:{title:'部長からのご挨拶（架空の例）',role:'部長',author:'サンプル',body:'読むことも、書くことも。それぞれの言葉を大切にする場所へ。'}}];
}
try{role=(await api('/api/session')).role;const config=await api('/api/status');if(!demo&&(!config.database||!config.auth)){$('banner').hidden=false;$('banner').textContent='初期設定待ちです。保存先・認証・アクセス制限の接続後に利用できます。';}await show('member');}catch(e){status(e.message);}

for(const form of document.querySelectorAll("form")){if(driveMode&&form.id==='pdf-form')continue;const handler=form.onsubmit;if(handler)form.onsubmit=async event=>{event.preventDefault();if(busy)return;busy=true;const controls=[...document.querySelectorAll("button")];controls.forEach(b=>b.disabled=true);try{await handler(event);}finally{busy=false;controls.forEach(b=>b.disabled=false);}};}
