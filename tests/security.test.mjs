import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { apply } from '../runtime/bounded-tools.mjs';
import { redactor, loadProfiles, validateProfiles } from '../src/config.mjs';

test('redaction handles escaped secrets, short known secrets and object keys', () => {
  const config = loadProfiles();
  process.env.HARNESS_MODEL_API_KEY = 'prefix"special\\secret';
  let clean = redactor(config); assert.deepEqual(clean({ nested: ['prefix"special\\secret'] }), { nested: ['[REDACTED]'] });
  process.env.HARNESS_MODEL_API_KEY = 'xy'; clean = redactor(config); assert.deepEqual(clean({ xy: 'a xy b' }), { '[REDACTED]': 'a [REDACTED] b' });
  delete process.env.HARNESS_MODEL_API_KEY;
});
test('profile rejects unknown tools, missing skills, bad limits, URLs with credential literals', () => {
  for (const change of [p => p.tools.push('bash'), p => p.skills.push('../x'), p => p.limits.max_steps=0, p => p.model.base_url='https://secret:token@host/']) {
    const config = loadProfiles(); change(config.profiles[0]); assert.throws(() => validateProfiles(config));
  }
});
test('bounded runtime tool denies arbitrary paths, other run ids, symlinks and invalid UTF8', async () => {
  const root = await mkdtemp('/tmp/harness-security-'), input = join(root, 'input'); await mkdir(input);
  const fileId = 'file_'+'a'.repeat(32), otherId = 'file_'+'b'.repeat(32), linkId = 'file_'+'c'.repeat(32), badId = 'file_'+'d'.repeat(32);
  await writeFile(join(input, fileId+'.bin'), 'safe content');
  await writeFile(join(root, 'outside'), 'must not read');
  await symlink(join(root, 'outside'), join(input, linkId+'.bin'));
  await writeFile(join(input, badId+'.bin'), Buffer.from([255]));
  let tool, guard;
  const ctx = { on() {}, effect(fn) { fn(); }, tools: { register(t) { tool=t; }, guard(fn) { guard=fn; return () => {}; } } };
  apply(ctx, { tools: ['read_attachment'], files: { [fileId]:{}, [linkId]:{}, [badId]:{} }, inputRoot: input, maxFileBytes: 1024, maxSteps: 8, maxOutputTokens: 100 });
  const exec = { signal: new AbortController().signal };
  assert.equal(await tool.execute({file_id:fileId}, exec), 'safe content');
  for (const value of ['../../outside', '/etc/passwd', otherId, linkId, badId]) await assert.rejects(() => tool.execute({file_id:value}, exec));
  assert.equal(guard({name:'read_attachment'}), undefined); assert.ok(guard({name:'bash'}));
});
