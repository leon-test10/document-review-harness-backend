# Local model stub

`model-stub.mjs` is a deterministic Node 24 HTTP fixture for the real harness/provider integration. It has no dependencies, calls no external model, needs no credentials, and does not simulate the harness itself.

```js
import { startModelStub } from './test-support/model-stub.mjs';

const stub = await startModelStub();
try {
  // Configure the provider with `${stub.url}/v1` and model `stub-model`.
  // Execute the actual backend/harness, then inspect stub.requests.
} finally {
  await stub.close();
}
```

Run independently with `node test-support/model-stub.mjs --port 8081`. Optional `--host`, `STUB_PORT`, and `STUB_HOST` select the listener; the default is `127.0.0.1` and an OS-allocated free port. The CLI prints only its origin URL, never request bodies or headers. Use SIGINT/SIGTERM to shut it down.

## HTTP interface

- `GET /v1/models` returns the `stub-model` entry.
- `POST /v1/chat/completions` accepts OpenAI `messages` and function `tools`. It defaults to SSE; `stream: false` returns the equivalent ordinary completion.
- Unprefixed `/models` and `/chat/completions` work too, for providers whose configured base URL already selects the prefix.
- SSE includes role/content deltas or incremental function arguments, `stop`/`tool_calls` finish reasons, a final usage chunk, and `[DONE]`. Token usage is a deterministic approximation, not tokenizer accounting.
- `requests` is a mutable array of parsed completion request bodies, including error/delay requests. It does not capture authorization headers. Treat message/tool contents as test data and do not send real secrets to this fixture.
- `close()` is idempotent and closes active connections and delayed responses. Requests above 4 MiB, malformed JSON, and malformed top-level messages/tools get HTTP errors.

## Prompt scenarios

The latest actual task user message selects a scenario; a system/developer instruction naming `document-review` also selects its Skill scenario. DSH's automatically appended runtime-context snapshots and Skill catalogs are excluded when finding that task message. Tool results after the task message determine the next action, so context injections cannot restart the tool sequence and multi-turn conversations remain independent.

- Ordinary text returns `stub: ` followed by the last user prompt.
- `USE_ATTACHMENT` calls an available `read_attachment` function with `{ "file_id": "..." }`, then includes the actual tool-result text in the final answer. IDs come from `attachment <id>`, a `file_id`/`attachment_id` field, or a JSON manifest's `id` field in message contents. If no ID exists, it uses `stub-attachment`.
- `document-review` calls an available `skill` function with `{ "name": "document-review" }` first, then `read_attachment`, then includes both real tool results and the `document-review Skill executed` marker. If a tool is unavailable, that step is skipped.
- `STUB_DELAY` waits 30 seconds before starting the response. Client disconnection or `close()` clears the timer promptly; use this to test cancellation rather than waiting 30 seconds.
- `STUB_ERROR` responds with HTTP 500 and an OpenAI-style `stub_error`. Provider retries receive the same failure.
- `STUB_LOOP` repeats a function call regardless of prior results to exercise the harness step limit. It prefers `read_attachment`, then `skill`, then the first other available function with simple required JSON-schema values. Provide `read_attachment` or `skill` for strictly predictable calls. With no functions it returns an explanatory final response.

`STUB_ERROR` takes precedence over other scenarios; `STUB_DELAY` can be combined with another scenario; `STUB_LOOP` takes precedence over attachment/skill sequencing. This is a test fixture, not a general-purpose OpenAI emulator or an actual model.
