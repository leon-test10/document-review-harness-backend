/** Launch only through DSH's supported profile CLI; never implement an agent loop here. */
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DSH_COMMIT = '571902028a75c64c1d767f4ae5fd099485f0ddf0';
export const DSH_VERSION = '0.2.1-alpha.3';

export async function prepareRuntime({ runRoot, profile, files, maxFileBytes }) {
  const home = join(runRoot, 'home');
  const dshHome = join(home, '.dsh');
  const profileDir = join(dshHome, 'profiles', 'backend');
  const workspace = join(runRoot, 'workspace');
  const skillRoot = join(runRoot, 'skills');
  const inputRoot = join(workspace, 'inputs');
  for (const path of [profileDir, workspace, inputRoot, skillRoot, join(runRoot, 'tmp')]) await mkdir(path, { recursive: true, mode: 0o700 });
  for (const skill of profile.skills) {
    await mkdir(join(skillRoot, skill), { recursive: true });
    await copyFile(join(ROOT, 'skills', skill, 'SKILL.md'), join(skillRoot, skill, 'SKILL.md'));
  }
  for (const file of files) await copyFile(file.path, join(inputRoot, `${file.id}.bin`));
  const plugin = (id, pkg, config) => ({ id, name: pkg.startsWith('/') ? pkg : `@deepseek-ai/${pkg}`, ...(config ? { config } : {}) });
  const rows = [
    plugin('timer', 'cordis-plugin-timer'),
    plugin('llm', 'dsh-llm'),
    plugin('session', 'dsh-session'),
    plugin('projections', 'dsh-session-projection'),
    plugin('system-prompt', 'dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: profile.system_prompt }),
    plugin('tools', 'dsh-tools', { mode: 'native', maxParallelSubCalls: 1 }),
    plugin('agents', 'dsh-agent'),
    plugin('loop', 'dsh-agent-loop', { agents: [], maxParallelToolCalls: 1 }),
    plugin('llm-retry', 'dsh-llm-retry'),
    plugin('model', 'dsh-llm-pi-ai', { providers: { [profile.model.provider]: {
      api: 'openai-completions', baseURL: profile.model.base_url,
      apiKeyEnv: profile.model.api_key_env,
      models: [{ id: profile.model.id, contextWindow: 32768, maxTokens: profile.limits.max_output_tokens, reasoningEfforts: false }],
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    } } }),
    plugin('default-model', 'dsh-agent-default-model', { provider: profile.model.provider, model: profile.model.id }),
    plugin('persistence', 'dsh-session-persistence-jsonl', { root: join(dshHome, 'sessions'), compression: 'none' }),
    plugin('filesystem', 'dsh-fs-local'),
    plugin('working-directory', 'dsh-working-directory', { defaultDirectory: workspace }),
    plugin('bounded-tools', join(ROOT, 'runtime', 'bounded-tools.mjs'), {
      tools: profile.tools, files: Object.fromEntries(files.map(f => [f.id, { name: f.name }])),
      inputRoot, maxFileBytes, maxSteps: profile.limits.max_steps, maxOutputTokens: profile.limits.max_output_tokens,
    }),
    plugin('timeout-policy', 'dsh-tool-call-timeout-policy'),
    ...(profile.plugins ?? []).map((entry, index) => ({ id: `extension-${index}`, name: entry.name, ...(entry.config ? { config: entry.config } : {}) })),
    ...(profile.tools.includes('skill') ? [
      plugin('skills', 'dsh-skill'),
      plugin('skill-filesystem', 'dsh-skill-filesystem', { includeDefaultRoots: false, customSkillDirs: [skillRoot], watch: false }),
      plugin('tool-skill', 'dsh-tool-skill'),
    ] : []),
    plugin('headless-startup', 'dsh-headless/startup'),
    { ...plugin('headless-runner', 'dsh-headless', { json: true }), inject: ['headlessStartup'] },
  ];
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'harness-runtime-profile', private: true, type: 'module', dsh: { profile: { bundles: [] } } }));
  // JSON is valid YAML; config is entirely server-owned, not client supplied.
  await writeFile(join(profileDir, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]));
  return { home, dshHome, workspace, runRoot };
}

export function launchRuntime(paths, profile, prompt) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: paths.home,
    DSH_HOME: paths.dshHome, DSH_AGENTS_HOME: join(paths.home, '.agents'),
    DSH_TELEMETRY_DISABLED: '1', TMPDIR: join(paths.runRoot, 'tmp'), LANG: 'C.UTF-8', NO_COLOR: '1',
  };
  const ref = profile.model.api_key_env;
  if (ref && process.env[ref]) env[ref] = process.env[ref];
  const child = spawn(process.execPath, [join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--profile', 'backend', '--json', '-'], {
    cwd: paths.workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Prompt travels through stdin, never through argv or launcher flags.
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  return child;
}

export function signalGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
export function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
