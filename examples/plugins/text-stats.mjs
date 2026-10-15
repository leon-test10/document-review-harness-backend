/** Trusted deployment extension example. No filesystem, shell or network capability. */
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'text-stats';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'text_stats', description: 'Count Unicode code points in supplied text.',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'integer' }, render: (_args, count) => [{ type: 'text', text: String(count) }] },
    async execute({ text }) { return Array.from(text).length; },
  }));
}
