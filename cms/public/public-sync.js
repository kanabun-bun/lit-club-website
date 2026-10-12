// The old public design remains. In the local simulator published data replaces
// its corresponding content; when no local API is available original HTML stays.
const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
function card(entry){
 const c=entry.content,e=make('article',undefined,'book reveal');
 e.append(make('h2',c.title));
 for(const key of ['author','role','date','place','address','description','body','issues','excerpt']){
  if(c[key])e.append(make('p',c[key],'description'));
 }
 if(c.contents){const details=make('details','', 'contents');details.append(make('summary','収録作品はこちら'));const list=make('div');for(const line of c.contents.split('\n'))if(line.trim())list.append(make('p',line,'contents-item'));details.append(list);e.append(details);}
 if(c.url){try{const url=new URL(c.url);if(['https:','http:'].includes(url.protocol)){const a=make('a','案内ページへ →','action');a.href=url.href;e.append(a);}}catch{}}
 return e;
}
try{
 const status=await fetch('/api/status',{cache:'no-store'});if(!status.ok)throw Error('no local backend');
 const config=await status.json();if(!config.localDemo)throw Error('no local backend');
 const result=await fetch('/api/public/entries',{cache:'no-store'});if(!result.ok)throw Error('API failed');
 const {items}=await result.json();
 const find=kind=>items.filter(e=>e.kind===kind);
 const group={president:'部長',vice:'副部長',members:'メンバー'};
 if(document.getElementById('president')){
  for(const [id,role]of Object.entries(group)){
   const list=document.getElementById(id);list.replaceChildren();
   for(const entry of find('message').filter(e=>e.content.role===role)){
    const article=make('article',undefined,'message-card visible');article.append(make('p',role,'message-role'),make('h3',entry.content.author||entry.content.title),make('p',entry.content.body||'','message-text'));list.append(article);
   }
   if(!list.children.length)list.append(make('p','公開中のメッセージはありません。'));
  }
 }
 if(document.getElementById('work-list')){
  const list=document.getElementById('work-list');list.replaceChildren(...find('introduction').map(e=>{
   const article=card(e),a=make('a','作品紹介を読む →','action');a.href='work-details.html?id='+encodeURIComponent(e.id);article.append(a);return article;
  }));
 }
 const detail=document.getElementById('local-detail');
 if(detail){const id=new URLSearchParams(location.search).get('id');const entry=find('introduction').find(e=>e.id===id);detail.replaceChildren(entry?card(entry):make('p','この紹介は公開されていません。'));}
 const list=document.getElementById('local-list');
 if(list)list.replaceChildren(...find(list.dataset.kind).map(card));
 const shelf=document.getElementById('shelf');
 if(shelf){
  const books=find('issue');shelf.replaceChildren(...books.map(e=>{
   const article=card(e);
   // Preserve the existing cover image for the original issue.
   if(e.id==='seed-issue'){const stage=make('div',undefined,'book-stage'),image=make('img');image.src='images/enjaku-54.jpg';image.alt='燕雀 No.54の表紙';image.style.maxHeight='260px';image.style.maxWidth='100%';stage.append(image);article.prepend(stage);}
   return article;
  }));
  document.getElementById('tools').hidden=true;
  const count=document.getElementById('empty');count.hidden=books.length>0;
 }
 const about=document.querySelector('#about .reveal:last-child');
 if(about){const pages=find('page');about.replaceChildren(...pages.flatMap(e=>[make('h3',e.content.title),make('p',e.content.body||'')]));if(!pages.length)about.append(make('p','活動紹介は準備中です。'));}
 const news=document.querySelector('#news .reveal:last-child');
 if(news){const notices=items.filter(e=>['event','notice'].includes(e.kind));news.replaceChildren(...notices.map(e=>{const row=make('article',undefined,'news-row');row.append(make('span',e.content.date||''),make('span',e.kind==='event'?'イベント':'お知らせ','news-label'),make('p',e.content.title));return row;}));if(!notices.length)news.append(make('p','お知らせは準備中です。'));}
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)location.reload();});
}catch{/* Plain static preview and public production keep the original content. */}
