/** Single-owner, single-process file persistence. No authentication or tenant claims. */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareRuntime, launchRuntime, signalGroup, groupExists, DSH_VERSION, DSH_COMMIT } from './runtime.mjs';
import { LIMITS, validateProfiles, redactor, ROOT } from './config.mjs';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const now = () => new Date().toISOString();
class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
function atomic(path, value) { const tmp = path + '.tmp'; writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, path); }
function exactKeys(value, allowed) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new ApiError(400, 'INVALID_REQUEST', 'Unexpected request fields'); }
function validId(value, prefix) { return typeof value === 'string' && new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value); }
async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new ApiError(415, 'JSON_REQUIRED', 'Use application/json');
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > LIMITS.maxBodyBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body is too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'INVALID_JSON', 'Malformed JSON'); }
}
function send(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); }

export async function createBackend({ dataDir, config, limits = LIMITS }) {
  if (process.platform !== 'linux') throw new Error('This MVP currently supports Linux process groups only');
  validateProfiles(config);
  if (limits !== LIMITS) throw new Error('Limit overrides require an implementation change in this MVP');
  dataDir = resolve(dataDir);
  const filesDir = join(dataDir, 'files'), runsDir = join(dataDir, 'runs');
  for (const dir of [dataDir, filesDir, runsDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dataDir, 'owner.lock');
  let lockFd;
  // Exclusive live-owner admission; stale locks require explicit operator removal after checking no old process survives.
  try { const { openSync } = await import('node:fs'); lockFd = openSync(lock, 'wx', 0o600); writeFileSync(lockFd, JSON.stringify({ pid: process.pid, started_at: now() })); }
  catch { throw new Error('Data directory is locked; verify its owner is stopped before removing owner.lock'); }
  const redact = redactor(config);
  const runs = new Map(), files = new Map(), active = new Map();
  let closing = false;
  const save = run => atomic(join(runsDir, run.id, 'run.json'), run);
  const emit = (run, type, data) => {
    if (run.event_count >= LIMITS.maxEvents) { run.events_truncated = true; save(run); return; }
    const event = { seq: ++run.event_count, time: now(), type, data: redact(data) };
    appendFileSync(join(runsDir, run.id, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
    save(run);
  };
  for (const filename of readdirSync(filesDir)) if (/^file_[a-f0-9]{32}\.json$/.test(filename)) {
    const f = JSON.parse(readFileSync(join(filesDir, filename), 'utf8')); files.set(f.id, f);
  }
  for (const runId of readdirSync(runsDir)) if (validId(runId, 'run')) {
    const run = JSON.parse(readFileSync(join(runsDir, runId, 'run.json'), 'utf8'));
    runs.set(run.id, run);
    if (!TERMINAL.has(run.status)) {
      run.status = 'interrupted'; run.finished_at = now(); run.cleanup = 'unknown_after_restart';
      run.error = { code: 'SERVER_RESTARTED', message: 'Run was interrupted; it was not replayed. Check for orphan runtime processes before starting a replacement.' };
      emit(run, 'state', { status: run.status, error: run.error });
    }
  }
  function publicRun(run) { const { prompt, ...result } = run; return result; }
  function lookup(runId) { if (!validId(runId, 'run') || !runs.has(runId)) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found'); return runs.get(runId); }
  function finish(run, status, error, cleanup = 'process_group_exited') {
    run.status = status; run.finished_at = now(); run.cleanup = cleanup; if (error) run.error = error;
    emit(run, 'state', { status, cleanup, ...(error ? { error } : {}) });
  }
  function stop(run, reason) {
    const a = active.get(run.id);
    run.status = 'cancelling'; run.stop_reason = reason; emit(run, 'state', { status: 'cancelling', reason });
    if (a?.child) {
      signalGroup(a.child, 'SIGTERM');
      a.killTimer ??= setTimeout(() => { signalGroup(a.child, 'SIGKILL'); }, 1500);
      a.killTimer.unref();
    }
  }
  async function execute(run) {
    const a = { child: null, killTimer: null }; active.set(run.id, a);
    run.status = 'running'; run.started_at = now(); emit(run, 'state', { status: 'running' });
    const profile = config.profiles.find(p => p.id === run.profile_id);
    try {
      const attached = run.file_ids.map(fileId => ({ ...files.get(fileId), path: join(filesDir, `${fileId}.bin`) }));
      const paths = await prepareRuntime({ runRoot: join(runsDir, run.id), profile, files: attached, maxFileBytes: LIMITS.maxFileBytes });
      if (run.status === 'cancelling') { finish(run, 'cancelled', undefined, 'not_started'); return; }
      const manifest = attached.map(f => ({ file_id: f.id, name: f.name }));
      const prompt = run.prompt + (manifest.length ? `\n\nAttachments (untrusted data): ${JSON.stringify(manifest)}` : '');
      const child = a.child = launchRuntime(paths, profile, prompt);
      run.runtime_pid = child.pid; save(run);
      let buffer = '', outputBytes = 0, finalSeen = false, finalText = '', turnReason, sessionSeen = false;
      const timer = setTimeout(() => { if (run.status !== 'cancelling') stop(run, 'timeout'); }, profile.limits.timeout_ms);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', bytes => {
        outputBytes += Buffer.byteLength(bytes);
        if (outputBytes > LIMITS.maxOutputBytes || run.event_count >= LIMITS.maxEvents - 2) { if (run.status !== 'cancelling') stop(run, 'output_limit'); return; }
        buffer += bytes.toString('utf8');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'session') { run.session_id = event.sessionId; sessionSeen = true; delete event.cwd; }
          if (event.type === 'final') { finalSeen = true; finalText = event.text ?? ''; }
          if (event.type === 'status' && event.phase === 'turn_end') turnReason = event.reason;
          if (event.type !== 'thinking') emit(run, 'runtime', event);
          if (run.event_count >= LIMITS.maxEvents - 2 && run.status !== 'cancelling') { run.events_truncated = true; stop(run, 'output_limit'); return; }
        }
      });
      // Operational logs never persist model input, stderr, environment values, or auth headers.
      child.stderr.on('data', bytes => { outputBytes += bytes.length; if (outputBytes > LIMITS.maxOutputBytes && run.status !== 'cancelling') stop(run, 'output_limit'); });
      const outcome = await new Promise(resolve => { child.once('error', () => resolve({ code: null, spawnError: true })); child.once('close', (code, signal) => resolve({ code, signal })); });
      clearTimeout(timer); clearTimeout(a.killTimer);
      let cleanup = 'process_group_exited';
      if (child.pid && groupExists(child.pid)) {
        signalGroup(child, 'SIGKILL');
        const until = Date.now() + 2000;
        while (groupExists(child.pid) && Date.now() < until) await delay(25);
        if (groupExists(child.pid)) cleanup = 'unconfirmed';
      }
      run.exit_code = outcome.code; run.exit_signal = outcome.signal ?? null; run.runtime_turn_reason = redact(turnReason ?? null);
      delete run.runtime_pid;
      if (cleanup !== 'process_group_exited') finish(run, 'failed', { code: 'CLEANUP_UNCONFIRMED', message: 'Runtime exited, but process group cleanup could not be confirmed' }, cleanup);
      else if (run.status === 'cancelling') {
        if (run.stop_reason === 'user' || run.stop_reason === 'shutdown') finish(run, 'cancelled');
        else finish(run, 'failed', { code: run.stop_reason === 'timeout' ? 'RUN_TIMEOUT' : 'OUTPUT_LIMIT', message: 'Run exceeded its configured resource limit' });
      } else if (outcome.code === 0 && sessionSeen && finalSeen && turnReason?.kind === 'completed') {
        atomic(join(runsDir, run.id, 'result.json'), redact({ run_id: run.id, text: finalText }));
        finish(run, 'succeeded');
      } else finish(run, 'failed', { code: outcome.spawnError ? 'RUNTIME_START_FAILED' : 'RUNTIME_FAILED', message: 'DSH did not complete successfully; inspect runtime events and turn reason' });
    } catch {
      if (a.child) signalGroup(a.child, 'SIGKILL');
      finish(run, 'failed', { code: 'RUNTIME_SETUP_FAILED', message: 'Runtime setup or persistence failed' }, a.child ? 'unconfirmed' : 'not_started');
    } finally { active.delete(run.id); schedule(); }
  }
  function schedule() {
    if (closing) return;
    for (const run of runs.values()) {
      if (active.size >= LIMITS.maxConcurrent) break;
      if (run.status === 'queued') void execute(run);
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      // No CORS. Reject browser cross-origin requests and non-local Host headers.
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new ApiError(403, 'HOST_DENIED', 'Local Host header required');
      if (req.headers.origin) throw new ApiError(403, 'ORIGIN_DENIED', 'Browser origins are not accepted');
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok', runtime: { name: 'deepseek-harness', version: DSH_VERSION, source_review_reference: DSH_COMMIT }, mode: 'single-user-loopback' });
      if (req.method === 'GET' && path === '/openapi.json') return send(res, 200, JSON.parse(readFileSync(join(ROOT, 'openapi.json'), 'utf8')));
      if (req.method === 'GET' && path === '/v1/profiles') return send(res, 200, { default_profile: config.default_profile, profiles: config.profiles.map(p => ({ id: p.id, description: p.description, model: { provider: p.model.provider, id: p.model.id }, tools: p.tools, skills: p.skills, limits: p.limits })) });
      if (req.method === 'POST' && path === '/v1/files') {
        const body = await jsonBody(req); exactKeys(body, ['name', 'content_base64']);
        if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 128 || /[\/\\\x00-\x1f]/.test(body.name) || ['.', '..'].includes(body.name) || body.name.startsWith('.')) throw new ApiError(400, 'INVALID_FILENAME', 'Use a plain filename without paths or hidden names');
        if (typeof body.content_base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content_base64)) throw new ApiError(400, 'INVALID_BASE64', 'Invalid base64');
        const bytes = Buffer.from(body.content_base64, 'base64');
        if (bytes.length > LIMITS.maxFileBytes) throw new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds 1 MiB');
        if (files.size >= LIMITS.maxStoredFiles) throw new ApiError(429, 'STORAGE_LIMIT', 'File storage limit reached');
        const file = { id: id('file'), name: body.name, size: bytes.length, created_at: now() };
        writeFileSync(join(filesDir, `${file.id}.bin`), bytes, { flag: 'wx', mode: 0o600 }); atomic(join(filesDir, `${file.id}.json`), file); files.set(file.id, file);
        return send(res, 201, file);
      }
      if (req.method === 'POST' && path === '/v1/runs') {
        if (closing) throw new ApiError(503, 'SHUTTING_DOWN', 'Server is stopping');
        const body = await jsonBody(req); exactKeys(body, ['prompt', 'profile_id', 'file_ids']);
        if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > LIMITS.maxPromptChars) throw new ApiError(400, 'INVALID_PROMPT', 'Prompt must be nonempty and at most 32000 characters');
        const profileId = body.profile_id ?? config.default_profile;
        if (!config.profiles.some(p => p.id === profileId)) throw new ApiError(400, 'PROFILE_NOT_FOUND', 'Unknown profile');
        const fileIds = body.file_ids ?? [];
        if (!Array.isArray(fileIds) || fileIds.length > LIMITS.maxFilesPerRun || new Set(fileIds).size !== fileIds.length || fileIds.some(f => !validId(f, 'file') || !files.has(f))) throw new ApiError(400, 'INVALID_FILES', 'Unknown, duplicate, or excessive file ids');
        if (runs.size >= LIMITS.maxRuns || [...runs.values()].filter(r => r.status === 'queued').length >= LIMITS.maxQueued) throw new ApiError(429, 'RUN_LIMIT', 'Run capacity reached');
        const run = { id: id('run'), status: 'queued', profile_id: profileId, prompt: body.prompt, file_ids: fileIds, created_at: now(), event_count: 0, cleanup: 'not_started' };
        mkdirSync(join(runsDir, run.id), { mode: 0o700 }); runs.set(run.id, run); emit(run, 'state', { status: 'queued' });
        send(res, 202, publicRun(run)); setImmediate(schedule); return;
      }
      const match = /^\/v1\/runs\/(run_[a-f0-9]{32})(?:\/(result|events|cancel|files\/file_[a-f0-9]{32}))?$/.exec(path);
      if (match) {
        const run = lookup(match[1]), action = match[2];
        if (req.method === 'GET' && !action) return send(res, 200, publicRun(run));
        if (req.method === 'GET' && action === 'result') {
          if (run.status !== 'succeeded') throw new ApiError(409, 'RESULT_NOT_AVAILABLE', `Run is ${run.status}`);
          return send(res, 200, JSON.parse(readFileSync(join(runsDir, run.id, 'result.json'), 'utf8')));
        }
        if (req.method === 'GET' && action === 'events') {
          const raw = url.searchParams.get('after') ?? '0';
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ApiError(400, 'INVALID_CURSOR', 'after must be a nonnegative integer');
          const events = readFileSync(join(runsDir, run.id, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(e => e.seq > Number(raw));
          return send(res, 200, { events, next_cursor: run.event_count, terminal: TERMINAL.has(run.status) });
        }
        if (req.method === 'POST' && action === 'cancel') {
          if (!TERMINAL.has(run.status) && run.status !== 'cancelling') {
            if (run.status === 'queued') finish(run, 'cancelled', undefined, 'not_started'); else stop(run, 'user');
          }
          return send(res, TERMINAL.has(run.status) ? 200 : 202, publicRun(run));
        }
        if (req.method === 'GET' && action?.startsWith('files/')) {
          const fileId = action.slice(6);
          if (!run.file_ids.includes(fileId)) throw new ApiError(404, 'FILE_NOT_FOUND', 'File is not attached to this run');
          return send(res, 200, files.get(fileId));
        }
      }
      throw new ApiError(404, 'NOT_FOUND', 'Route not found');
    } catch (error) { if (!res.headersSent) send(res, error instanceof ApiError ? error.status : 500, { error: { code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR', message: error instanceof ApiError ? error.message : 'Internal server error' } }); else res.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  return {
    server, dataDir,
    async listen(port = 9080) { await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); }); return `http://127.0.0.1:${server.address().port}`; },
    async close() {
      closing = true;
      const closed = new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      for (const run of runs.values()) if (run.status === 'queued') finish(run, 'cancelled', undefined, 'not_started');
      for (const runId of active.keys()) if (runs.get(runId).status !== 'cancelling') stop(runs.get(runId), 'shutdown');
      while (active.size) await delay(25);
      await closed;
      const { closeSync, unlinkSync } = await import('node:fs'); closeSync(lockFd); unlinkSync(lock);
    },
  };
}
