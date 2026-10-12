import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).parents[1]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
demo=load('demo',ROOT/'local_demo.py');migration=load('migration',ROOT/'tools/export_github.py')

class ExportTest(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
 def tearDown(self):self.temp.cleanup()
 def test_read_only_migration_keeps_drafts_ids_and_pdf_bytes(self):
  source=self.root/'original';store=demo.Store(source)
  store.db.execute("UPDATE entries SET draft_json=? WHERE id='seed-about'",(json.dumps({'title':'編集中','body':'下書き保存'}),))
  data=b'%PDF-1.4\noriginal\n%%EOF';(source/'pdfs').mkdir();(source/'pdfs/work-4.pdf').write_bytes(data)
  store.db.execute("UPDATE works SET pdf_key='work-4.pdf',member_status='published',search_text='非公開本文' WHERE id='work-4'");store.db.commit();store.db.close()
  before=(source/'demo.sqlite3').read_bytes()
  output=self.root/'export';state=migration.export(output,source)
  self.assertEqual((source/'demo.sqlite3').read_bytes(),before)
  entry=next(e for e in state['entries'] if e['id']=='seed-about');self.assertEqual(entry['draft']['title'],'編集中');self.assertNotEqual(entry['published']['title'],'編集中')
  work=next(w for w in state['works'] if w['id']=='work-4');self.assertEqual((output/work['pdf_key']).read_bytes(),data);self.assertEqual(work['search_text'],'非公開本文')
  manifest=json.loads((output/'SHA256SUMS.json').read_text())
  for name,digest in manifest.items():self.assertEqual(hashlib.sha256((output/name).read_bytes()).hexdigest(),digest)
  self.assertTrue((output/'local-backup.sqlite3').is_file())
 def test_missing_pdf_stops_without_partial_export_or_source_changes(self):
  source=self.root/'original';store=demo.Store(source);store.db.execute("UPDATE works SET pdf_key='missing.pdf' WHERE id='work-4'");store.db.commit();store.db.close()
  before=(source/'demo.sqlite3').read_bytes();output=self.root/'export'
  with self.assertRaises(ValueError):migration.export(output,source)
  self.assertFalse(output.exists());self.assertEqual((source/'demo.sqlite3').read_bytes(),before)
 def test_never_overwrites_export_and_missing_database_never_becomes_seed(self):
  output=self.root/'export';migration.export(output,seed=True)
  with self.assertRaises(ValueError):migration.export(output,seed=True)
  with self.assertRaises(ValueError):migration.export(self.root/'bad',self.root/'missing')
 def test_exported_seed_passes_worker_validator(self):
  import subprocess
  output=self.root/'export';migration.export(output,seed=True)
  code="import fs from 'node:fs';import {validateState} from "+json.dumps((ROOT/'server/github-store.mjs').as_uri())+";validateState(JSON.parse(fs.readFileSync(process.argv[1])));"
  subprocess.run(['node','--input-type=module','-e',code,str(output/'data/state.json')],check=True)

if __name__=='__main__':unittest.main()
