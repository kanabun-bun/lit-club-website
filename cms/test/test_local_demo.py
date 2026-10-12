import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

spec=importlib.util.spec_from_file_location("local_demo",Path(__file__).parents[1]/"local_demo.py")
demo=importlib.util.module_from_spec(spec);spec.loader.exec_module(demo)

class LocalDemoTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory()
  self.server=demo.make_server(self.temp.name,0)
  self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
  self.cookie=""
 def tearDown(self):
  self.server.shutdown();self.server.server_close();self.thread.join();self.server.store.db.close();self.temp.cleanup()
 def request(self,path,method="GET",data=None,cookie=None,origin=True):
  conn=http.client.HTTPConnection("127.0.0.1",self.server.server_port)
  headers={"Cookie":self.cookie if cookie is None else cookie}
  if origin:headers["Origin"]=f"http://127.0.0.1:{self.server.server_port}"
  if isinstance(data,bytes):body=data;headers["Content-Type"]="application/pdf"
  elif data is not None:body=json.dumps(data).encode();headers["Content-Type"]="application/json"
  else:body=None
  conn.request(method,path,body,headers);r=conn.getresponse();raw=r.read();status=r.status;cookie_header=r.getheader("Set-Cookie")
  if cookie_header:self.cookie=cookie_header.split(";")[0]
  conn.close()
  try:value=json.loads(raw)
  except ValueError:value=raw
  return status,value
 def login(self,role):
  self.assertEqual(self.request("/api/login","POST",{"role":role,"password":role+"-demo"})[0],200)
 def test_publish_snapshot_conflict_unpublish_and_persistence(self):
  self.login("admin")
  status,data=self.request("/api/admin/entries","POST",{"kind":"message","content":{"title":"試験","role":"部長","author":"test","body":"最初"}})
  self.assertEqual(status,201);key=data["id"]
  change={"content":{"title":"試験","role":"部長","author":"test","body":"公開版"},"action":"publish","version":1}
  self.assertEqual(self.request("/api/admin/entries/"+key,"PUT",change)[0],200)
  def published():return next(e for e in self.request("/api/public/entries")[1]["items"] if e["id"]==key)
  self.assertEqual(published()["content"]["body"],"公開版")
  change["content"]["body"]="非公開の変更";change["action"]="save";change["version"]=2
  self.assertEqual(self.request("/api/admin/entries/"+key,"PUT",change)[0],200)
  self.assertEqual(published()["content"]["body"],"公開版")
  self.assertEqual(self.request("/api/admin/entries/"+key,"PUT",change)[0],409)
  second=demo.Store(self.temp.name)
  try:self.assertEqual(json.loads(second.db.execute("SELECT draft_json FROM entries WHERE id=?",(key,)).fetchone()[0])["body"],"非公開の変更")
  finally:second.db.close()
  change["action"]="unpublish";change["version"]=3
  self.assertEqual(self.request("/api/admin/entries/"+key,"PUT",change)[0],200)
  self.assertFalse(any(e["id"]==key for e in self.request("/api/public/entries")[1]["items"]))
 def test_pdf_upload_authorization_member_search_and_quota(self):
  self.assertEqual(self.request("/api/admin/works")[0],403)
  self.login("admin")
  authors=self.request("/api/admin/authors")[1]["items"]
  status,w=self.request("/api/admin/works","POST",{"title":"試験作品","credited_name":"掲載名","author_id":authors[0]["id"]})
  self.assertEqual(status,201);key=w["id"]
  self.assertEqual(self.request("/api/admin/works/"+key,"PUT",{"member_status":"published","search_text":"secret"})[0],400)
  pdf=b"%PDF-1.4\nlocal test\n%%EOF"
  self.assertEqual(self.request("/api/admin/works/"+key+"/pdf","PUT",pdf)[0],200)
  self.assertEqual(self.request("/api/admin/works/"+key,"PUT",{"member_status":"published","search_text":"非公開検索本文"})[0],200)
  self.assertEqual(self.request("/api/member/works/"+key+"/pdf",cookie="")[0],401)
  self.login("member")
  self.assertEqual(self.request("/api/admin/works")[0],403)
  status,result=self.request("/api/member/works?q=%E9%9D%9E%E5%85%AC%E9%96%8B")
  self.assertEqual(status,200);self.assertEqual(result["items"][0]["id"],key);self.assertNotIn("search_text",result["items"][0])
  self.assertEqual(self.request("/api/member/works/"+key+"/pdf")[1],pdf)
  self.login("admin");self.server.store.max_bytes=1
  self.assertEqual(self.request("/api/admin/works/"+key+"/pdf","PUT",pdf+b"larger")[0],413)
 def test_local_only_and_csrf(self):
  self.assertEqual(self.request("/api/login","POST",{"role":"admin","password":"admin-demo"},origin=False)[0],403)
  self.assertEqual(self.request("/api/login","POST",{"role":"admin","password":"wrong"})[0],401)
  self.assertEqual(self.request("/member-area.html")[0],200)
  self.assertEqual(self.request("/api/status")[1]["localDemo"],True)

if __name__=="__main__":unittest.main()
