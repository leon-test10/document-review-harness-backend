/** Extension plugin: limits and attachment capability; the DSH loop owns execution. */
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'harness-bounded-tools';
export const inject = ['tools', 'agents'];
export function apply(ctx, config) {
  const counts = new WeakMap();
  ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ allow: config.tools }); });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const count = (counts.get(agent) ?? 0) + 1;
    counts.set(agent, count);
    if (count > config.maxSteps) throw Object.assign(new Error('Maximum model steps exceeded'), { code: 'STEP_LIMIT' });
    return next();
  });
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: config.maxOutputTokens }));
  const allowed = new Set(config.tools);
  ctx.effect(() => ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'Tool is not allowed by this profile'));
  if (!allowed.has('read_attachment')) return;
  ctx.tools.register(defineTool({
    name: 'read_attachment',
    description: 'Read an attached UTF-8 text file by its exact file_id in the attachment manifest. No filesystem paths are accepted.',
    parameters: { file_id: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    timeoutMs: 5000,
    async execute({ file_id }, exec) {
      if (!/^file_[a-f0-9]{32}$/.test(file_id) || !Object.hasOwn(config.files, file_id)) throw new Error('ATTACHMENT_NOT_ALLOWED');
      const root = await realpath(config.inputRoot);
      const candidate = resolve(root, `${file_id}.bin`);
      const canonical = await realpath(candidate);
      if (!canonical.startsWith(root + sep) || canonical !== candidate) throw new Error('ATTACHMENT_PATH_DENIED');
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > config.maxFileBytes) throw new Error('ATTACHMENT_SIZE_DENIED');
        const bytes = await handle.readFile({ signal: exec.signal });
        if (bytes.length > config.maxFileBytes) throw new Error('ATTACHMENT_SIZE_DENIED');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } finally { await handle.close(); }
    },
  }));
}
