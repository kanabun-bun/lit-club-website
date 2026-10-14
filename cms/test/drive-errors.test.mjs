import test from 'node:test';
import assert from 'node:assert/strict';
import {DriveStore} from '../server/drive-store.mjs';
test('Drive errors expose only operation/status/known reason, never raw Google messages',async()=>{
 const store=new DriveStore({},async()=>Response.json({error:{message:'SECRET_FILE_NAME TOKEN_VALUE',details:[{reason:'SERVICE_DISABLED'}],errors:[{reason:'accessNotConfigured'}]}},{status:403}));
 store.accessToken='test-only';
 await assert.rejects(()=>store.request('files/test','フォルダ情報の取得'),e=>e.status===503&&e.message.includes('SERVICE_DISABLED')&&e.message.includes('フォルダ情報の取得')&&!e.message.includes('SECRET')&&!e.message.includes('TOKEN'));
});
test('Drive permission errors distinguish failed operations and redact unknown reasons',async()=>{
 for(const reason of ['insufficientFilePermissions','secret_should_not_escape']){
  const store=new DriveStore({},async()=>Response.json({error:{errors:[{reason}]}},{status:403}));store.accessToken='test-only';
  await assert.rejects(()=>store.request('files/test/permissions','PDFの共有設定の確認'),e=>e.message.includes('PDFの共有設定の確認')&&e.message.includes('HTTP 403')&&e.message.includes(reason==='insufficientFilePermissions'?reason:'UNKNOWN')&&!e.message.includes('secret_should'));
 }
});
