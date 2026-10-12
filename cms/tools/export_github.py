#!/usr/bin/env python3
"""Read-only migration: make a new, validated private-data directory; never overwrite."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
MAX_PDF=10_000_000
MAX_STATE=4_000_000

def export(destination, data_dir=None, seed=False):
 destination=Path(destination).resolve()
 if destination.exists():raise ValueError("出力先が存在します。上書きせず、新しいフォルダ名を指定してください")
 if data_dir is not None and (destination==Path(data_dir).resolve() or Path(data_dir).resolve() in destination.parents):raise ValueError("元データの外に出力してください")
 destination.parent.mkdir(parents=True,exist_ok=True)
 stage=Path(tempfile.mkdtemp(prefix=".cms-export-",dir=destination.parent))
 state={"schemaVersion":1,"version":1,"authors":[],"works":[],"entries":[],"audit":[]}
 try:
  if seed:
   initial=json.loads((ROOT/"seed.json").read_text())
   state["authors"]=[dict(a,membership="current",version=1) for a in initial["authors"]]
   state["works"]=[dict(w,search_text="",member_status="draft",pdf_key=None,pdf_bytes=0,version=1,updated_at=str(time.time())) for w in initial["works"]]
   state["entries"]=[{"id":e["id"],"kind":e["kind"],"draft":e["content"],"published":e["content"],"version":1,"updated_at":str(time.time())} for e in initial["entries"]]
  else:
   source=Path(data_dir).resolve();dbfile=source/"demo.sqlite3"
   if not dbfile.is_file():raise ValueError("元のdemo.sqlite3がありません。初期データで代用しません")
   live=sqlite3.connect(dbfile.as_uri()+"?mode=ro",uri=True)
   backup=sqlite3.connect(stage/"local-backup.sqlite3")
   try:live.backup(backup)
   finally:live.close()
   try:
    backup.row_factory=sqlite3.Row
    if backup.execute("PRAGMA integrity_check").fetchone()[0]!="ok" or backup.execute("PRAGMA foreign_key_check").fetchone():raise ValueError("SQLiteの整合性検査に失敗しました")
    state["authors"]=[dict(r,version=1) for r in backup.execute("SELECT * FROM authors ORDER BY id")]
    state["works"]=[dict(r,version=1,pdf_bytes=0) for r in backup.execute("SELECT * FROM works ORDER BY id")]
    state["entries"]=[{"id":r["id"],"kind":r["kind"],"version":r["version"],"draft":json.loads(r["draft_json"]),"published":json.loads(r["published_json"]) if r["published_json"] else None,"updated_at":r["updated_at"]} for r in backup.execute("SELECT * FROM entries ORDER BY id")]
    state["audit"]=[dict(r) for r in backup.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 500")][::-1]
   finally:backup.close()
   # Stop the local server during export so the PDFs match the SQLite snapshot.
   for w in state["works"]:
    if not w["pdf_key"]:continue
    key=w["pdf_key"]
    if Path(key).name!=key:raise ValueError("PDF保存名を確認してください")
    pdf=source/"pdfs"/key
    if not pdf.is_file() or pdf.is_symlink():raise ValueError("登録済みPDFが見つかりません。移行を中止しました")
    if pdf.stat().st_size>MAX_PDF:raise ValueError("10MBを超えるPDFがあります。元データは維持して移行を中止しました")
    data=pdf.read_bytes()
    if not data.startswith(b"%PDF-"):raise ValueError("登録済みPDFの形式が不正です")
    w["pdf_key"]="pdfs/"+w["id"]+"-"+hashlib.sha256(data).hexdigest()+".pdf";w["pdf_bytes"]=len(data)
    target=stage/w["pdf_key"];target.parent.mkdir(exist_ok=True);target.write_bytes(data)
  authors={a["id"] for a in state["authors"]};works={w["id"] for w in state["works"]}
  for group in (state["authors"],state["works"],state["entries"]):
   if len({r["id"] for r in group})!=len(group) or any(not re.fullmatch(r"[a-zA-Z0-9-]{1,100}",r["id"]) for r in group):raise ValueError("IDが不正または重複しています")
  for w in state["works"]:
   if w["author_id"] not in authors or w["member_status"]=="published" and not w["pdf_key"]:raise ValueError("作品と作者・PDFの参照が不正です")
  for e in state["entries"]:
   for c in (e["draft"],e["published"]):
    if c is not None and (not isinstance(c,dict) or not c.get("title") or e["kind"]=="introduction" and c.get("workId") not in works):raise ValueError("記事の参照が不正です")
  payload=(json.dumps(state,ensure_ascii=False,indent=2)+"\n").encode()
  if len(payload)>MAX_STATE:raise ValueError("文章データが4MBを超えています")
  if sum(w["pdf_bytes"] for w in state["works"])>256_000_000:raise ValueError("PDFの合計容量が256MBを超えています")
  (stage/"data").mkdir();(stage/"data/state.json").write_bytes(payload)
  manifest={str(p.relative_to(stage)):hashlib.sha256(p.read_bytes()).hexdigest() for p in stage.rglob('*') if p.is_file()}
  (stage/"SHA256SUMS.json").write_text(json.dumps(manifest,indent=2)+"\n")
  stage.rename(destination)
  return state
 finally:
  if stage.exists():shutil.rmtree(stage)

if __name__=="__main__":
 p=argparse.ArgumentParser(description=__doc__);source=p.add_mutually_exclusive_group(required=True)
 source.add_argument("--data-dir");source.add_argument("--seed",action="store_true");p.add_argument("--output",required=True)
 args=p.parse_args()
 try:
  result=export(args.output,args.data_dir,args.seed)
  print("書き出し完了: 作者 %d / 作品 %d / 記事 %d。元データは変更していません。"%(len(result["authors"]),len(result["works"]),len(result["entries"])))
 except (ValueError,sqlite3.DatabaseError,OSError,KeyError) as error:
  p.exit(1,"移行を中止しました: "+str(error)+"\n")
