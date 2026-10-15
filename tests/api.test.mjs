import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBackend } from '../src/backend.mjs';
import { loadProfiles } from '../src/config.mjs';
async function app() {
  const dataDir = await mkdtemp('/tmp/harness-api-');
  const backend = await createBackend({ dataDir, config: loadProfiles() });
  const url = await backend.listen(0);
  const req = async (path, body, headers = {}) => { const r = await fetch(url+path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : {'content-type':'application/json'}), ...headers }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) }); return {status:r.status, body:await r.json()}; };
  return { backend, dataDir, req };
}
test('HTTP validates filenames, base64, profiles, request fields and attachment ownership', async () => {
  const f = await app();
  try {
    for (const name of ['../x', '/etc/passwd', '..', '.env', 'a\\b', 'a\u0000b']) assert.equal((await f.req('/v1/files', {name,content_base64:'YQ=='})).status, 400);
    assert.equal((await f.req('/v1/files', {name:'ok.txt',content_base64:'??'})).status, 400);
    assert.equal((await f.req('/v1/files', {name:'big.txt',content_base64:Buffer.alloc(1048577).toString('base64')})).status, 413);
    for (const input of [{prompt:''},{prompt:'x',profile_id:'missing'},{prompt:'x',cwd:'/etc'},{prompt:'x',file_ids:['file_'+'a'.repeat(32)]},{prompt:'x',model:'other'}]) assert.equal((await f.req('/v1/runs',input)).status,400);
    assert.equal((await f.req('/health',undefined,{origin:'https://evil.invalid'})).status,403);
    const { request: httpRequest } = await import('node:http');
    const hostStatus = await new Promise(resolve => { const request = httpRequest({hostname:'127.0.0.1',port:f.backend.server.address().port,path:'/health',headers:{host:'attacker.invalid'}}, res => { res.resume(); resolve(res.statusCode); }); request.end(); });
    assert.equal(hostStatus,403);
    assert.equal((await f.req('/v1/runs/%2e%2e%2f')).status,404);
    assert.equal((await f.req('/v1/profiles')).status,200);
  } finally { await f.backend.close(); }
});
test('restart marks stale work interrupted, preserves completed records and never replays', async () => {
  const dataDir = await mkdtemp('/tmp/harness-restart-'), runId = 'run_'+'a'.repeat(32);
  await mkdir(join(dataDir,'runs',runId),{recursive:true});
  await writeFile(join(dataDir,'runs',runId,'run.json'),JSON.stringify({id:runId,status:'running',profile_id:'general',prompt:'never automatically replay me',file_ids:[],event_count:0,created_at:new Date().toISOString()}));
  const backend=await createBackend({dataDir,config:loadProfiles()});
  try {
    const url=await backend.listen(0), r=await (await fetch(url+'/v1/runs/'+runId)).json();
    assert.equal(r.status,'interrupted'); assert.equal(r.cleanup,'unknown_after_restart'); assert.equal(r.error.code,'SERVER_RESTARTED');
    const disk=JSON.parse(await readFile(join(dataDir,'runs',runId,'run.json'),'utf8'));assert.equal(disk.status,'interrupted');
    await assert.rejects(()=>createBackend({dataDir,config:loadProfiles()}),/locked/);
  } finally { await backend.close(); }
});
