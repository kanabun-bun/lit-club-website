export const kinds = ['introduction','issue','message','event','store','notice','page'];
export const fields = {
 introduction: ['title','workId','author','body','excerpt'],
 issue: ['title','number','date','description','contents'],
 message: ['title','role','author','body'],
 event: ['title','date','place','body','url'],
 store: ['title','address','body','url','issues'],
 notice: ['title','date','body'],
 page: ['title','body']
};
export function validateContent(kind, input) {
 if(!kinds.includes(kind) || !input || typeof input!=='object' || Array.isArray(input)) throw new Error('入力形式が不正です');
 const out={};
 for(const field of fields[kind]){
  if(input[field]===undefined) continue;
  if(typeof input[field]!=='string' || input[field].length>20000) throw new Error('文字数または入力形式を確認してください');
  out[field]=input[field].trim();
 }
 if(!out.title || out.title.length>200) throw new Error('見出しを200文字以内で入力してください');
 if(kind==='introduction' && !out.workId) throw new Error('対象の作品を選んでください');
 if(kind==='message' && !['部長','副部長','メンバー'].includes(out.role)) throw new Error('役職を選んでください');
 if(out.url){const url=new URL(out.url);if(!['https:','http:'].includes(url.protocol))throw new Error('URLはhttpsまたはhttpで入力してください');}
 return out;
}
export function publicEntry(row){
 if(!row.published_json) return null;
 return {id:row.id,kind:row.kind,content:validateContent(row.kind,JSON.parse(row.published_json))};
}
export function normalize(text){return String(text).normalize('NFKC').toLocaleLowerCase('ja');}
