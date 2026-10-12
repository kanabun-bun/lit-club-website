#!/usr/bin/env python3
"""Local-only persistent CMS demonstration. Python standard library only."""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
import unicodedata
import uuid
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parent
KINDS = {
 "introduction": ["title","workId","author","body","excerpt"],
 "issue": ["title","number","date","description","contents"],
 "message": ["title","role","author","body"],
 "event": ["title","date","place","body","url"],
 "store": ["title","address","body","url","issues"],
 "notice": ["title","date","body"],
 "page": ["title","body"]
}
def normalize(value):
 return unicodedata.normalize("NFKC", str(value)).lower()
def content(kind, value):
 if kind not in KINDS or not isinstance(value, dict): raise ValueError("入力形式を確認してください")
 out = {}
 for key in KINDS[kind]:
  if key in value:
   if not isinstance(value[key], str) or len(value[key]) > 20000: raise ValueError("文章が長すぎます")
   out[key] = value[key].strip()
 if not out.get("title") or len(out["title"]) > 200: raise ValueError("見出しを200文字以内で入力してください")
 if kind == "message" and out.get("role") not in ("部長","副部長","メンバー"): raise ValueError("役職を選んでください")
 if kind == "introduction" and not out.get("workId"): raise ValueError("作品を選んでください")
 if out.get("url") and urlsplit(out["url"]).scheme not in ("http","https"): raise ValueError("URLを確認してください")
 return out

class Store:
 def __init__(self, directory):
  self.directory = Path(directory)
  self.directory.mkdir(parents=True, exist_ok=True)
  self.lock = threading.RLock()
  self.db = sqlite3.connect(self.directory / "demo.sqlite3", check_same_thread=False)
  self.db.row_factory = sqlite3.Row
  if not self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entries'").fetchone():
   self.db.executescript((ROOT / "migrations/0001_cms.sql").read_text())
  self.secret = secrets.token_bytes(32)  # restart logs users out, records remain
  self.sessions = {}
  self.max_bytes = 8_500_000_000
  if not self.db.execute("SELECT 1 FROM entries LIMIT 1").fetchone():
   seed_path=ROOT/"seed.json"
   seed=json.loads(seed_path.read_text()) if seed_path.exists() else {}
   for author in seed.get("authors",[]): self.db.execute("INSERT OR IGNORE INTO authors VALUES(?,?,?)",(author["id"],author["label"],"current"))
   for work in seed.get("works",[]): self.db.execute("INSERT OR IGNORE INTO works(id,author_id,title,credited_name,updated_at) VALUES(?,?,?,?,?)",(work["id"],work["author_id"],work["title"],work["credited_name"],str(time.time())))
   for entry in seed.get("entries",[]):
    value=json.dumps(entry["content"],ensure_ascii=False)
    self.db.execute("INSERT INTO entries VALUES(?,?,?,?,1,?)",(entry["id"],entry["kind"],value,value,str(time.time())))
   self.db.commit()

class Handler(SimpleHTTPRequestHandler):
 def __init__(self, *args, **kwargs):
  super().__init__(*args, directory=str(ROOT/"public"), **kwargs)
 def log_message(self, fmt, *args):
  # Do not print query strings, credentials or member search words.
  pass
 @property
 def store(self): return self.server.store
 def reply(self, data, status=200, headers=None):
  payload=json.dumps(data,ensure_ascii=False).encode()
  self.send_response(status)
  self.send_header("Content-Type","application/json; charset=utf-8")
  self.send_header("Cache-Control","no-store")
  self.send_header("X-Content-Type-Options","nosniff")
  self.send_header("Content-Length",str(len(payload)))
  for key,value in (headers or {}).items():self.send_header(key,value)
  self.end_headers()
  self.wfile.write(payload)
 def role(self):
  try:
   cookies=SimpleCookie(self.headers.get("Cookie",""))
   token=cookies["club_local"].value
   data=self.store.sessions.get(token)
   return data["role"] if data and data["expires"]>time.time() else "guest"
  except (KeyError,ValueError): return "guest"
 def incoming(self, max_bytes=200000):
  size=int(self.headers.get("Content-Length","0"))
  if not 0<size<=max_bytes: raise ValueError("ファイルサイズまたは入力を確認してください")
  data=self.rfile.read(size)
  if len(data)!=size: raise ValueError("送信が完了していません")
  return data
 def json_input(self):return json.loads(self.incoming())
 def do_GET(self): self.dispatch("GET")
 def do_POST(self): self.dispatch("POST")
 def do_PUT(self): self.dispatch("PUT")
 def dispatch(self, method):
  host=urlsplit("http://"+self.headers.get("Host","")).hostname
  if host not in ("localhost","127.0.0.1"):
   return self.reply({"error":"このデモはPC内からのみ利用できます"},403)
  path=urlsplit(self.path).path
  if not path.startswith("/api/"):
   if method!="GET":return self.reply({"error":"未対応の操作"},405)
   return super().do_GET()
  if method!="GET" and self.headers.get("Origin")!="http://"+self.headers.get("Host"):
   return self.reply({"error":"送信元を確認できません"},403)
  try:
   with self.store.lock:self.api(path,method)
  except (ValueError,KeyError,TypeError,json.JSONDecodeError) as error:
   self.store.db.rollback()
   self.reply({"error":str(error) if isinstance(error,ValueError) else "入力形式を確認してください"},400)
  except Exception:
   self.store.db.rollback()
   self.reply({"error":"ローカル保存に失敗しました。空き容量を確認してください"},500)
 def api(self,path,method):
  db=self.store.db
  role=self.role()
  query=parse_qs(urlsplit(self.path).query)
  if path=="/api/status":return self.reply({"database":True,"storage":True,"auth":True,"localDemo":True,"pdfUpload":True})
  if path=="/api/session":return self.reply({"role":role})
  if path=="/api/login" and method=="POST":
   data=self.json_input()
   expected={"member":"member-demo","admin":"admin-demo"}.get(data.get("role"))
   if not expected or not hmac.compare_digest(str(data.get("password","")),expected):
    return self.reply({"error":"デモ用パスワードを確認してください"},401)
   token=secrets.token_urlsafe(32)
   self.store.sessions[token]={"role":data["role"],"expires":time.time()+28800}
   return self.reply({"role":data["role"]},headers={"Set-Cookie":f"club_local={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800"})
  if path=="/api/logout" and method=="POST":
   try:self.store.sessions.pop(SimpleCookie(self.headers.get("Cookie",""))["club_local"].value,None)
   except KeyError:pass
   return self.reply({"ok":True},headers={"Set-Cookie":"club_local=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"})
  if path.startswith("/api/admin/") and role!="admin":return self.reply({"error":"管理者ログインが必要です"},403)
  if path.startswith("/api/member/") and role=="guest":return self.reply({"error":"部員ログインが必要です"},401)
  if path=="/api/public/entries" and method=="GET":
   q=normalize(query.get("q",[""])[0])
   items=[]
   for row in db.execute("SELECT id,kind,published_json FROM entries WHERE published_json IS NOT NULL"):
    value=content(row["kind"],json.loads(row["published_json"]))
    if q in normalize(" ".join(value.values())):items.append({"id":row["id"],"kind":row["kind"],"content":value})
   return self.reply({"items":items})
  if path=="/api/admin/authors":
   if method=="GET":return self.reply({"items":[dict(r) for r in db.execute("SELECT * FROM authors ORDER BY label")]})
   if method=="POST":
    x=self.json_input()
    if not isinstance(x.get("label"),str) or not x["label"].strip() or len(x["label"])>100 or x.get("membership") not in ("current","alumni"):raise ValueError("作者情報を確認してください")
    key=str(uuid.uuid4());db.execute("INSERT INTO authors VALUES(?,?,?)",(key,x["label"].strip(),x["membership"]));db.commit();return self.reply({"id":key},201)
  if path=="/api/admin/works":
   if method=="GET":return self.reply({"items":[dict(r) for r in db.execute("SELECT * FROM works ORDER BY updated_at DESC")]})
   if method=="POST":
    x=self.json_input()
    if not isinstance(x.get("title"),str) or not x["title"].strip() or len(x["title"])>200 or not isinstance(x.get("credited_name"),str) or not db.execute("SELECT 1 FROM authors WHERE id=?",(x.get("author_id"),)).fetchone():raise ValueError("作品と作者を確認してください")
    key=str(uuid.uuid4());db.execute("INSERT INTO works(id,author_id,title,credited_name,updated_at) VALUES(?,?,?,?,?)",(key,x["author_id"],x["title"].strip(),x["credited_name"],str(time.time())));db.commit();return self.reply({"id":key},201)
  work_parts=path.split("/")
  if path.startswith("/api/admin/works/") and len(work_parts)==5 and method=="PUT":
   x=self.json_input();key=work_parts[4]
   if x.get("member_status") not in ("draft","published"):raise ValueError("会員公開状態を選んでください")
   if not isinstance(x.get("search_text",""),str) or len(x.get("search_text",""))>1000000:raise ValueError("検索本文を確認してください")
   work=db.execute("SELECT * FROM works WHERE id=?",(key,)).fetchone()
   if not work:return self.reply({"error":"作品がありません"},404)
   if x["member_status"]=="published" and not work["pdf_key"]:raise ValueError("先にPDFを登録してください")
   db.execute("UPDATE works SET search_text=?,member_status=?,updated_at=? WHERE id=?",(x.get("search_text",""),x["member_status"],str(time.time()),key))
   db.execute("INSERT INTO audit(action,target_id) VALUES('work-save',?)",(key,));db.commit();return self.reply({"ok":True})
  if path.startswith("/api/admin/works/") and path.endswith("/pdf") and len(work_parts)==6 and method=="PUT":
   key=work_parts[4]
   row=db.execute("SELECT pdf_key FROM works WHERE id=?",(key,)).fetchone()
   if not row:return self.reply({"error":"作品がありません"},404)
   data=self.incoming(50_000_000)
   if not data.startswith(b"%PDF-"):raise ValueError("PDFファイルを選んでください")
   files=self.store.directory/"pdfs";files.mkdir(exist_ok=True)
   destination=files/(key+".pdf")
   old_size=destination.stat().st_size if destination.exists() else 0
   total=sum(p.stat().st_size for p in files.glob("*.pdf"))
   if total-old_size+len(data)>self.store.max_bytes:return self.reply({"error":"保存容量の上限です。登録を停止しました"},413)
   temp=destination.with_suffix(".tmp")
   temp.write_bytes(data);os.replace(temp,destination)
   db.execute("UPDATE works SET pdf_key=?,updated_at=? WHERE id=?",(key+".pdf",str(time.time()),key));db.commit()
   return self.reply({"ok":True,"bytes":len(data)})
  if path=="/api/member/works" and method=="GET":
   q=normalize(query.get("q",[""])[0])
   items=[{"id":r["id"],"title":r["title"],"author":r["credited_name"],"hasPdf":bool(r["pdf_key"])} for r in db.execute("SELECT * FROM works WHERE member_status='published'") if q in normalize(r["title"]+" "+r["credited_name"]+" "+r["search_text"])]
   return self.reply({"items":items})
  if path.startswith("/api/member/works/") and path.endswith("/pdf") and len(work_parts)==6 and method=="GET":
   row=db.execute("SELECT pdf_key FROM works WHERE id=? AND member_status='published'",(work_parts[4],)).fetchone()
   if not row or not row["pdf_key"]:return self.reply({"error":"PDFがありません"},404)
   file=self.store.directory/"pdfs"/Path(row["pdf_key"]).name
   if not file.exists():return self.reply({"error":"PDFがありません"},404)
   self.send_response(200)
   self.send_header("Content-Type","application/pdf")
   self.send_header("Content-Disposition","inline")
   self.send_header("Content-Length",str(file.stat().st_size))
   self.send_header("Cache-Control","private, no-store")
   self.end_headers()
   with file.open("rb") as stream:
    while chunk:=stream.read(65536):self.wfile.write(chunk)
   return
  if path=="/api/admin/entries":
   if method=="GET":return self.reply({"items":[{"id":r["id"],"kind":r["kind"],"version":r["version"],"draft":json.loads(r["draft_json"]),"published":json.loads(r["published_json"]) if r["published_json"] else None} for r in db.execute("SELECT * FROM entries ORDER BY updated_at DESC")]})
   if method=="POST":
    x=self.json_input();value=content(x["kind"],x["content"])
    self.validate_work(x["kind"],value)
    key=str(uuid.uuid4());db.execute("INSERT INTO entries VALUES(?,?,?,NULL,1,?)",(key,x["kind"],json.dumps(value,ensure_ascii=False),str(time.time())))
    db.execute("INSERT INTO audit(action,target_id) VALUES('create',?)",(key,));db.commit();return self.reply({"id":key},201)
  if path.startswith("/api/admin/entries/") and len(work_parts)==5 and method=="PUT":
   key=work_parts[4];x=self.json_input();row=db.execute("SELECT * FROM entries WHERE id=?",(key,)).fetchone()
   if not row:return self.reply({"error":"記事がありません"},404)
   if x.get("action") not in ("save","publish","unpublish"):raise ValueError("操作を確認してください")
   value=content(row["kind"],x["content"]);self.validate_work(row["kind"],value)
   published=json.dumps(value,ensure_ascii=False) if x["action"]=="publish" else None if x["action"]=="unpublish" else row["published_json"]
   result=db.execute("UPDATE entries SET draft_json=?,published_json=?,version=version+1,updated_at=? WHERE id=? AND version=?",(json.dumps(value,ensure_ascii=False),published,str(time.time()),key,x.get("version")))
   if not result.rowcount:db.rollback();return self.reply({"error":"別の編集が入りました。一覧を再読み込みしてください"},409)
   db.execute("INSERT INTO audit(action,target_id) VALUES(?,?)",(x["action"],key));db.commit();return self.reply({"ok":True})
  return self.reply({"error":"未対応の操作です"},404)
 def validate_work(self,kind,value):
  if kind=="introduction" and not self.store.db.execute("SELECT 1 FROM works WHERE id=?",(value["workId"],)).fetchone():raise ValueError("対象作品がありません")

def make_server(directory, port=8000):
 server=ThreadingHTTPServer(("127.0.0.1",port),Handler)
 server.store=Store(directory)
 return server
if __name__=="__main__":
 parser=argparse.ArgumentParser()
 parser.add_argument("--port",type=int,default=8000)
 parser.add_argument("--data-dir",default=str(ROOT/".local-demo"))
 args=parser.parse_args()
 server=make_server(args.data_dir,args.port)
 print(f"プレビュー: http://127.0.0.1:{server.server_port}/",flush=True)
 print("部員パスワード: member-demo / 管理者: admin-demo",flush=True)
 print("入力内容はこのPCに保存します。終了: Control+C",flush=True)
 try:server.serve_forever()
 except KeyboardInterrupt:pass
 finally:server.server_close();server.store.db.close()
