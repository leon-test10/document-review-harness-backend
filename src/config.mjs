import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LIMITS = Object.freeze({ maxFileBytes: 1024 * 1024, maxBodyBytes: 1500000, maxPromptChars: 32000, maxFilesPerRun: 8, maxStoredFiles: 100, maxRuns: 1000, maxConcurrent: 2, maxQueued: 16, maxEvents: 2000, maxOutputBytes: 2 * 1024 * 1024 });
export function validateProfiles(config) {
  if (!config || !Array.isArray(config.profiles) || !config.profiles.length) throw new Error('Invalid profiles config');
  const seen = new Set();
  for (const p of config.profiles) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(p.id) || seen.has(p.id)) throw new Error('Invalid or duplicate profile id');
    seen.add(p.id);
    if (!Array.isArray(p.tools) || p.tools.some(t => typeof t !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(t))) throw new Error('Invalid tool names');
    if (p.plugins !== undefined && (!Array.isArray(p.plugins) || p.plugins.some(plugin => !plugin || typeof plugin.name !== 'string' || !(plugin.name.startsWith('/') || /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(plugin.name))))) throw new Error('Invalid trusted plugin configuration');
    if (!p.plugins?.length && p.tools.some(t => !['read_attachment', 'skill'].includes(t))) throw new Error('Custom tools require a reviewed runtime plugin');
    if (!Array.isArray(p.skills) || p.skills.some(s => !/^[a-z][a-z0-9-]{0,63}$/.test(s))) throw new Error('Invalid Skill ids');
    if (p.skills.length && !p.tools.includes('skill')) throw new Error('Skills require skill tool');
    for (const skill of p.skills) readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'));
    if (!p.model || !/^[a-z][a-z0-9-]{0,63}$/.test(p.model.provider) || typeof p.model.id !== 'string' || !p.model.id) throw new Error('Invalid model');
    const url = new URL(p.model.base_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid model URL');
    if (p.model.api_key_env && !/^[A-Z][A-Z0-9_]{0,100}$/.test(p.model.api_key_env)) throw new Error('Invalid API key environment reference');
    if (typeof p.system_prompt !== 'string' || p.system_prompt.length > 32000) throw new Error('Invalid system prompt');
    for (const [key, max] of [['max_steps', 100], ['max_output_tokens', 32768], ['timeout_ms', 600000]]) {
      if (!Number.isInteger(p.limits?.[key]) || p.limits[key] < 1 || p.limits[key] > max) throw new Error(`Invalid ${key}`);
    }
  }
  if (!seen.has(config.default_profile)) throw new Error('Unknown default_profile');
  return config;
}
export function loadProfiles(path = process.env.HARNESS_CONFIG ?? join(ROOT, 'config', 'profiles.example.json')) {
  return validateProfiles(JSON.parse(readFileSync(path, 'utf8')));
}
export function redactor(config) {
  const secrets = config.profiles.map(p => process.env[p.model.api_key_env]).filter(v => typeof v === 'string' && v.length);
  function clean(text) {
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
  }
  function visit(value) {
    if (typeof value === 'string') return clean(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), visit(item)]));
    return value;
  }
  return visit;
}
