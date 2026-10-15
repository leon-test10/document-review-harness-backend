#!/usr/bin/env node
/** Deterministic, dependency-free OpenAI Chat Completions fixture. */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MODEL_ID = 'stub-model';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DELAY_MS = 30_000;

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map(part => typeof part === 'string' ? part : part?.text ?? '').join('\n');
}

function taskUserIndex(messages) {
  return messages.findLastIndex(message => {
    if (message.role !== 'user') return false;
    const text = contentText(message.content).trimStart();
    // DSH projects these automatic context snapshots as user messages.
    if (text.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')) return false;
    if (text.startsWith('<system-reminder>') && text.includes('<available_skills>')) return false;
    return true;
  });
}

function attachmentId(messages) {
  const texts = messages.map(message => contentText(message.content)).reverse();
  // Explicit IDs beat incidental mentions of attachments in skill instructions.
  const prompt = contentText(messages[taskUserIndex(messages)]?.content);
  const explicit = prompt.match(/\battachment\s+[`"']?([\w:-]+(?:\.[\w:-]+)*)/i);
  if (explicit && !['manifest', 'content', 'contents', 'data', 'file', 'files', 'id'].includes(explicit[1].toLowerCase())) return explicit[1];
  for (const text of texts) {
    const match = text.match(/["']?(?:file_id|attachment_id)["']?\s*[:=]\s*[`"']?([\w][\w.:-]*)/i);
    if (match) return match[1];
  }
  for (const text of texts) {
    const match = text.match(/["']id["']\s*:\s*["']([^"']+)["']/i);
    if (match) return match[1];
  }
  return 'stub-attachment';
}

function toolResults(messages) {
  const calls = new Map();
  const results = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, call.function?.name);
    if (message.role === 'tool') {
      results.push({ name: message.name ?? calls.get(message.tool_call_id), text: contentText(message.content) });
    }
  }
  return results;
}

function schemaValue(schema = {}) {
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (Object.hasOwn(schema, 'default')) return schema.default;
  if (schema.type === 'object' || schema.properties) {
    return Object.fromEntries((schema.required ?? []).map(key => [key, schemaValue(schema.properties?.[key])]));
  }
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => schemaValue(schema.items));
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 0;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'null') return null;
  return 'stub';
}

function planResponse(body, requestNumber) {
  const messages = body.messages;
  const lastUserIndex = taskUserIndex(messages);
  const prompt = contentText(messages[lastUserIndex]?.content);
  const currentTurn = messages.slice(lastUserIndex + 1);
  const results = toolResults(currentTurn);
  const tools = (body.tools ?? []).filter(tool => tool?.type === 'function' && tool.function?.name).map(tool => tool.function);
  const readTool = tools.find(tool => tool.name === 'read_attachment');
  const skillTool = tools.find(tool => tool.name === 'skill');
  const instructions = messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => contentText(message.content)).join('\n');
  const wantsSkill = /document-review/i.test(`${prompt}\n${instructions}`);
  const wantsAttachment = /USE_ATTACHMENT/i.test(prompt) || wantsSkill;
  const fileId = attachmentId(messages);
  const call = (tool, args) => ({
    role: 'assistant', content: null,
    tool_calls: [{ id: `call_stub_${requestNumber}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(args) } }],
  });

  if (prompt.includes('STUB_LOOP')) {
    if (readTool) return call(readTool, { file_id: fileId });
    if (skillTool) return call(skillTool, { name: 'document-review' });
    if (tools[0]) return call(tools[0], schemaValue(tools[0].parameters));
    return { role: 'assistant', content: 'stub: STUB_LOOP requires an available function tool' };
  }
  if (wantsSkill && skillTool && !results.some(result => result.name === skillTool.name)) {
    return call(skillTool, { name: 'document-review' });
  }
  if (wantsAttachment && readTool && !results.some(result => result.name === readTool.name)) {
    return call(readTool, { file_id: fileId });
  }
  if (wantsAttachment && results.length) {
    const resultText = results.map(result => `${result.name ?? 'tool'} result: ${result.text}`).join('\n');
    const skillMarker = wantsSkill && results.some(result => result.name === 'skill') ? 'document-review Skill executed\n' : '';
    return { role: 'assistant', content: `stub: ${skillMarker}${resultText}` };
  }
  return { role: 'assistant', content: `stub: ${prompt}` };
}

function jsonResponse(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function sendCompletion(response, body, message, requestNumber) {
  const id = `chatcmpl-stub-${requestNumber}`;
  const model = body.model ?? MODEL_ID;
  const created = 0;
  const finishReason = message.tool_calls ? 'tool_calls' : 'stop';
  const promptTokens = Math.max(1, Math.ceil(JSON.stringify(body.messages).length / 4));
  const completionTokens = Math.max(1, Math.ceil(JSON.stringify(message).length / 4));
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  if (body.stream === false) {
    jsonResponse(response, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message, finish_reason: finishReason }], usage,
    });
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache', connection: 'keep-alive',
  });
  response.flushHeaders();
  const frame = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  frame({ role: 'assistant', content: '' });
  if (message.tool_calls) {
    for (const [index, tool] of message.tool_calls.entries()) {
      frame({ tool_calls: [{ index, id: tool.id, type: 'function', function: { name: tool.function.name, arguments: '' } }] });
      for (const fragment of tool.function.arguments.match(/.{1,12}/gs) ?? []) {
        frame({ tool_calls: [{ index, function: { arguments: fragment } }] });
      }
    }
  } else {
    for (const fragment of message.content.match(/.{1,24}/gs) ?? []) frame({ content: fragment });
  }
  frame({}, finishReason);
  response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
  response.end('data: [DONE]\n\n');
}

/**
 * Start a local test model. Requests contains parsed completion bodies only;
 * credentials and HTTP headers are never retained or logged.
 * @param {{ port?: number, host?: string }} options Listener address; port 0 allocates a free port.
 * @returns {Promise<{url: string, server: import('node:http').Server, requests: object[], close: () => Promise<void>}>}
 */
export async function startModelStub({ port = 0, host = '127.0.0.1' } = {}) {
  const requests = [];
  const pendingTimers = new Set();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://stub.local').pathname;
    if (request.method === 'GET' && ['/v1/models', '/models'].includes(path)) {
      jsonResponse(response, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'local-test' }] });
      return;
    }
    if (request.method !== 'POST' || !['/v1/chat/completions', '/chat/completions'].includes(path)) {
      jsonResponse(response, 404, { error: { message: 'Unknown model-stub endpoint', type: 'invalid_request_error' } });
      return;
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          jsonResponse(response, 413, { error: { message: 'Request exceeds 4 MiB', type: 'invalid_request_error' } });
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        jsonResponse(response, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
        return;
      }
      if (!body || !Array.isArray(body.messages) || body.messages.some(message => !message || typeof message !== 'object') || (body.tools != null && !Array.isArray(body.tools))) {
        jsonResponse(response, 400, { error: { message: 'messages must be an array of objects; tools must be an array', type: 'invalid_request_error' } });
        return;
      }
      requests.push(body);
      const requestNumber = requests.length;
      const prompt = contentText(body.messages[taskUserIndex(body.messages)]?.content);
      if (prompt.includes('STUB_ERROR')) {
        jsonResponse(response, 500, { error: { message: 'Deterministic STUB_ERROR failure', type: 'server_error', code: 'stub_error' } });
        return;
      }
      const message = planResponse(body, requestNumber);
      const finish = () => {
        if (!response.destroyed && !response.writableEnded) sendCompletion(response, body, message, requestNumber);
      };
      if (prompt.includes('STUB_DELAY')) {
        if (response.destroyed) return;
        // A disconnected cancellation clears its timer rather than keeping tests alive.
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          finish();
        }, DELAY_MS);
        pendingTimers.add(timer);
        response.once('close', () => {
          clearTimeout(timer);
          pendingTimers.delete(timer);
        });
      } else finish();
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        if (response.headersSent) response.destroy();
        else jsonResponse(response, 400, { error: { message: 'Unable to process model-stub request', type: 'invalid_request_error' } });
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const urlHost = host.includes(':') ? `[${host}]` : host;
  let closing;
  return {
    url: `http://${urlHost}:${address.port}`, server, requests,
    close() {
      closing ??= new Promise((resolve, reject) => {
        for (const timer of pendingTimers) clearTimeout(timer);
        pendingTimers.clear();
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const hostIndex = args.indexOf('--host');
  const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.STUB_PORT ?? 0);
  const host = hostIndex >= 0 ? args[hostIndex + 1] : process.env.STUB_HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !host) throw new Error('Expected --port 0..65535 and a nonempty --host');
  const stub = await startModelStub({ port, host });
  process.stdout.write(`${stub.url}\n`);
  const stop = () => { void stub.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
