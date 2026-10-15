import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBackend } from '../../src/backend.mjs';
import { loadProfiles } from '../../src/config.mjs';
import { startModelStub } from '../../test-support/model-stub.mjs';
async function fixture() {
  const stub = await startModelStub();
  const config = loadProfiles();
  for (const p of config.profiles) p.model.base_url = stub.url + '/v1';
  process.env.HARNESS_MODEL_API_KEY = 'local-test-only';
  const dataDir = await mkdtemp('/tmp/harness-integration-');
  const backend = await createBackend({ dataDir, config });
  const url = await backend.listen(0);
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const wait = async runId => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const { body } = await request('/v1/runs/' + runId);
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(body.status)) return body;
      await delay(30);
    }
    throw new Error('Run did not settle');
  };
  return { stub, backend, config, dataDir, url, request, wait, close: async () => { await backend.close(); await stub.close(); } };
}
test('real DSH plain request reaches model and commits completed turn', async () => {
  const f = await fixture();
  try {
    const { body: run } = await f.request('/v1/runs', { prompt: 'hello generic world' });
    const done = await f.wait(run.id); assert.equal(done.status, 'succeeded', JSON.stringify(done));
    const { body: result } = await f.request(`/v1/runs/${run.id}/result`); assert.match(result.text, /hello generic world/);
    assert.equal(f.stub.requests.length, 1);
    const { body } = await f.request(`/v1/runs/${run.id}/events`);
    assert.ok(body.events.some(e => e.data.type === 'session'));
    assert.ok(body.events.some(e => e.data.phase === 'turn_end' && e.data.reason.kind === 'completed'));
    assert.equal(f.stub.requests[0].max_tokens ?? f.stub.requests[0].max_completion_tokens, 1024);
  } finally { await f.close(); }
});
test('real DSH Skill loader and attachment tool complete multiple model steps', async () => {
  const f = await fixture();
  try {
    const { body: file } = await f.request('/v1/files', { name: 'sample.txt', content_base64: Buffer.from('Unique review attachment: acceptance date missing.').toString('base64') });
    const { body: run } = await f.request('/v1/runs', { prompt: 'Review the supplied document.', profile_id: 'document-review', file_ids: [file.id] });
    const done = await f.wait(run.id); assert.equal(done.status, 'succeeded', JSON.stringify(done));
    const { body: events } = await f.request(`/v1/runs/${run.id}/events`);
    const calls = events.events.filter(e => e.data.type === 'tool_call').map(e => e.data.tool);
    assert.deepEqual(calls, ['skill', 'read_attachment']);
    const { body: result } = await f.request(`/v1/runs/${run.id}/result`);
    assert.match(result.text, /DOCUMENT_REVIEW_V1/); assert.match(result.text, /Unique review attachment/);
    assert.equal(f.stub.requests.length, 3);
    const sessionsDir = join(f.dataDir, 'runs', run.id, 'home', '.dsh', 'sessions');
    const { readdir } = await import('node:fs/promises'); assert.ok((await readdir(sessionsDir)).length);
  } finally { await f.close(); }
});
test('cancel acknowledges cancelling and only settles after runtime group exit', async () => {
  const f = await fixture();
  try {
    const { body: run } = await f.request('/v1/runs', { prompt: 'STUB_DELAY please' });
    const end = Date.now() + 10000; while (!f.stub.requests.length && Date.now() < end) await delay(20);
    assert.ok(f.stub.requests.length);
    const response = await f.request(`/v1/runs/${run.id}/cancel`, {});
    assert.equal(response.status, 202); assert.equal(response.body.status, 'cancelling');
    const done = await f.wait(run.id); assert.equal(done.status, 'cancelled'); assert.equal(done.cleanup, 'process_group_exited');
    assert.equal((await f.request(`/v1/runs/${run.id}/result`)).status, 409);
  } finally { await f.close(); }
});
test('DSH step guard enforces finite model loop; error final never means succeeded', async () => {
  const f = await fixture();
  try {
    const { body: run } = await f.request('/v1/runs', { prompt: 'STUB_LOOP' });
    const done = await f.wait(run.id); assert.equal(done.status, 'failed'); assert.equal(f.stub.requests.length, 8);
    assert.equal((await f.request(`/v1/runs/${run.id}/result`)).status, 409);
    const { body } = await f.request(`/v1/runs/${run.id}/events`);
    assert.ok(body.events.some(e => e.data.type === 'final'));
  } finally { await f.close(); }
});
test('upstream model error produces failed run rather than fake result', async () => {
  const f = await fixture();
  try {
    const { body: run } = await f.request('/v1/runs', { prompt: 'STUB_ERROR' });
    const done = await f.wait(run.id); assert.equal(done.status, 'failed');
    assert.equal((await f.request(`/v1/runs/${run.id}/result`)).status, 409);
  } finally { await f.close(); }
});
test('run without attached file cannot read another run file through actual DSH tool', async () => {
  const f = await fixture();
  try {
    const { body: file } = await f.request('/v1/files', { name: 'private.txt', content_base64: Buffer.from('OTHER_RUN_PRIVATE_SENTINEL').toString('base64') });
    const { body: run } = await f.request('/v1/runs', { prompt: 'USE_ATTACHMENT attachment ' + file.id });
    const done = await f.wait(run.id); assert.equal(done.status, 'succeeded');
    const { body } = await f.request(`/v1/runs/${run.id}/events`);
    assert.ok(body.events.some(e => e.data.type === 'tool_result' && e.data.status === 'error' && e.data.result.includes('ATTACHMENT_NOT_ALLOWED')));
    assert.ok(!JSON.stringify(f.stub.requests).includes('OTHER_RUN_PRIVATE_SENTINEL'));
    assert.equal((await f.request(`/v1/runs/${run.id}/files/${file.id}`)).status, 404);
  } finally { await f.close(); }
});
test('trusted deployment plugin uses DSH tool registration; profile allowlist hides unallowed tools', async () => {
  const stub=await startModelStub(), config=loadProfiles();
  process.env.HARNESS_MODEL_API_KEY='local-test-only';
  config.profiles[0].model.base_url=stub.url+'/v1';
  config.profiles[0].plugins=[{name: new URL('../../examples/plugins/text-stats.mjs',import.meta.url).pathname}];
  config.profiles[0].tools=['read_attachment'];
  const backend=await createBackend({dataDir:await mkdtemp('/tmp/harness-plugin-'),config});
  try {
    const url=await backend.listen(0);
    const run=await (await fetch(url+'/v1/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'hello plugin scope'})})).json();
    let state;const end=Date.now()+10000;do { state=await(await fetch(url+'/v1/runs/'+run.id)).json();if(['failed','succeeded'].includes(state.status))break;await delay(20);}while(Date.now()<end);
    assert.equal(state.status,'succeeded',JSON.stringify(state));
    assert.deepEqual(stub.requests[0].tools.map(t=>t.function.name),['read_attachment']);
  } finally {await backend.close();await stub.close();}
});
