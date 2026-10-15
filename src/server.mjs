import { resolve } from 'node:path';
import { createBackend } from './backend.mjs';
import { loadProfiles } from './config.mjs';
import { startModelStub } from '../test-support/model-stub.mjs';
const config = loadProfiles();
let stub;
// Demo mode is explicit and never silently substitutes for a configured provider.
if (process.env.HARNESS_DEMO === '1') {
  stub = await startModelStub();
  for (const profile of config.profiles) {
    profile.model = { provider: 'local-stub', id: 'stub-model', base_url: stub.url + '/v1', api_key_env: 'HARNESS_STUB_KEY' };
  }
  process.env.HARNESS_STUB_KEY = 'local-test-only';
}
const backend = await createBackend({ dataDir: resolve(process.env.HARNESS_DATA_DIR ?? './data'), config });
const url = await backend.listen(Number(process.env.HARNESS_PORT ?? '9080'));
console.log(JSON.stringify({ listening: url, demo_model: Boolean(stub), runtime: 'DSH 0.2.1-alpha.3' }));
let stopping = false;
async function close() { if (stopping) return; stopping = true; await backend.close(); await stub?.close(); }
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
