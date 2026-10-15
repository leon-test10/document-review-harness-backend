# Verification report

Date: 2026-10-15 UTC. Platform: Linux, Node.js 24.19.0, npm 11.9.0.

## Runtime genuinely exercised

The backend launched the official `@deepseek-ai/dsh@0.2.1-alpha.3` CLI using a custom headless profile. The model boundary alone was replaced by a loopback HTTP Chat Completions stub. No real vendor credentials or real business documents were used.

Observed native event sequence includes session, turn_start, step_start, text/tool_call/tool_result, step_end with token usage, turn_end and final. Plain prompt required one provider request. The Skill scenario required three provider requests and actual DSH tool order `skill` then `read_attachment`. The final response contained `DOCUMENT_REVIEW_V1` from the loaded SKILL.md and a unique string from the actual uploaded file. Upstream JSONL session persistence was created.

## Automated project suite

- `npm test`: 5 tests passed.
  - HTTP filename/path/base64/size/profile/unknown-field/Origin/Host rejection.
  - Restart interruption without replay, persisted terminal state, exclusive owner lock.
  - Known-secret redaction including quotes, backslashes, object keys and short secrets.
  - Profile validation rejects invalid tools, paths, limits and credential-bearing URLs.
  - Bounded tool rejects arbitrary paths, unassigned file IDs, symlinks and invalid UTF-8.
- `npm run test:integration`: 7 tests passed against real DSH.
  - Plain task and committed success; configured output token cap observed on provider request.
  - Native Skill→attachment→answer loop, three model requests.
  - Cancellation during active model wait: 202 cancelling, then cancelled after process-group exit.
  - Eight-step guard stops a repeated tool loop; failure final is not mistaken for success.
  - Model HTTP error maps to failed with no result.
  - Cross-run file read denied by actual tool; private file contents never reach the model.
  - Trusted extension loads through DSH, but a tool excluded by the profile is hidden from model schemas.
- `npm run check`: JavaScript syntax checks passed.
- OpenAPI JSON generated and parsed successfully; API route behavior covered by HTTP tests.

A test initially found that adding a tool restriction at pre-step was too late to remove that step's already assembled schema. The restriction now installs on native agent/created; the focused case and final full suite both pass. Earlier failures were not counted as passes.

## Clean-install reproducibility

The exact allowlisted source files were copied into a fresh directory with no node_modules. `npm ci --ignore-scripts --no-audit --no-fund` completed successfully using the committed lockfile, followed by 5/5 API/unit tests, 7/7 real-DSH integration tests and syntax checks. This verifies an npm-based clean install on the tested Linux/Node version; it does not verify Docker or other operating systems.

## Independent acceptance

Final independent review passed 42 checks in total: the 12 project tests above rerun independently, plus 21 independent HTTP black-box checks, 7 deeper runtime checks, 1 forced-supervisor-crash/recovery test, and 1 allowed custom-plugin execution test. These are not 42 independently authored tests.

The deeper checks confirmed actual Skill and attachment results reaching subsequent model requests, cross-run API and tool denial, cancellation after the model request was truly in flight, watchdog timeout, a no-tools Profile, secret redaction, graceful restart/cursor stability, and safe owner-lock handling after SIGKILL. A trusted `text_stats` extension executed through the actual DSH tool pipeline and returned 4 for its test text. Final behavior-file hashes were unchanged during that acceptance pass.

Event-cap persistence and UTF-8 stream-decoding fixes received static review; no output-flood stress test is claimed. Raw session data, credentials and machine-specific test directories are not packaged here.

## Source pin check

The npm runtime version is exact and lockfile-resolved. `git diff --quiet dsh-v0.2.1-alpha.3 571902028a75c64c1d767f4ae5fd099485f0ddf0 -- apps/cli/src packages/bundle/headless packages/core packages/llm packages/skill packages/session` returned 0. This verifies the inspected source paths match between tag and review reference; it is not a local build or binary reproducibility claim. See SOURCE_REFERENCES.md.

## Not verified / deliberately excluded

- Real model providers, 4A integration, real-data output quality and provider billing.
- Docker image build/run: no Docker CLI or daemon was available in this development environment.
- OS sandboxing, untrusted custom plugins, escaped process-group descendants, multi-tenancy, authentication, distributed queues, PostgreSQL, load/performance, long-term retention/backup.
- PDF/DOCX/image parsing, arbitrary executable Skill bundles, multi-turn session resume, SSE token streams and generated-file downloads.

Do not describe this as production-ready enterprise infrastructure or as verified against a real commercial model API.
