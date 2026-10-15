# Runtime source and dependency pins

## Executable artifact

- Package: `@deepseek-ai/dsh@0.2.1-alpha.3`
- Registry tarball: https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-alpha.3.tgz
- npm lock integrity: `sha512-RngmQ6wIOo58crUgOMcIoj7IRo62ZZuPVORJ65jnUd1m4XbRGYtn63uPW81pjw7eJvkf8o6uaggkGF+Urfzf5w==`
- Every dependency is resolved in `package-lock.json`; install using `npm ci --ignore-scripts`.
- The backend executes the installed official `dsh/lib/bin.js` with a server-owned custom profile. It does not execute a rewritten loop.

## Source references inspected

- Official repository: https://github.com/deepseek-ai/deepseek-harness
- Official version tag: https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.3
- Tag commit: `2fbf4359b82fb94c03dcce0b831660d87f12ea5c`
- Source-review reference: `571902028a75c64c1d767f4ae5fd099485f0ddf0`

The reviewed merge commit is not claimed as the exact locally built executable. The runtime pin is the official npm publication plus lock integrity. No npm `gitHead` was available in that publication, so this project does not claim independently verified byte-for-byte correspondence between the npm artifact and a local source build.

The official tag and review reference have identical source under the used `apps/cli/src`, `packages/bundle/headless`, `packages/core`, `packages/llm`, `packages/skill`, and `packages/session` paths (verified with git diff --quiet). The full repository does contain other changes. An independent reviewer also checked the runtime paths.

## Upstream files inspected

- `apps/cli/src/profile-boot.ts`: supported custom profile launcher and shutdown.
- `packages/bundle/headless/src/index.ts`, `json-stream.ts`: actual one-shot lifecycle, session projection, final and exit semantics.
- `packages/core/agent-loop/src/index.ts`: real loop and agent registry composition.
- `packages/core/tools/src/index.ts`: registration, per-agent restriction and execution guard.
- `packages/skill/skill-filesystem/src/index.ts`, `tool-skill/src/index.ts`: isolated Skill roots and actual model-callable loader.
- `packages/llm/llm-pi-ai`: OpenAI-compatible provider adapter.

Upstream is MIT-licensed. The npm dependency retains its own LICENSE and notices. This source package does not redistribute the full upstream checkout or node_modules.
