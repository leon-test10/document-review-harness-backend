# 文档审查 harness 后端框架

`document-review-harness-backend` 第一版。底层是通用 LLM / Agent 后端；文档审查只是服务器预置的示例 Skill。没有 P0、Android 仓库或专用审查分支依赖。

## 已经实现

- HTTP：附件上传、服务器 Profile 列表、创建 Run、状态、结果、可重放的 JSON 事件增量读取、取消。
- 真实 DeepSeek Harness：官方 CLI profile launcher → 原生 headless → agent-loop → provider → tool pipeline → Skill registry / filesystem provider / skill 工具 → JSONL session persistence。
- 默认无 shell、无任意文件系统工具、无浏览器、无 MCP、无子代理。模型只有当前 Profile 明确注册且允许的工具。
- 每个 Run 独立工作目录、DSH_HOME 和 Linux 进程组；附件读取工具只接受当前 Run 的附件 ID。
- 普通任务与 `document-review` Skill 两条流程都有真实 DSH 集成测试。测试只替换模型服务，未替换 Harness runner。

这是单用户、可信本机调用方的 Linux MVP。不是多租户服务；没有账号鉴权、数据库队列或企业级隔离。不要公开监听或直接放在公网反向代理后面。

## 运行

需要 Linux、Node.js 24+、npm。开发验证环境：Node 24.19.0 / npm 11.9.0。

```sh
npm ci --ignore-scripts
npm test
npm run test:integration
npm run demo
```

默认监听 `http://127.0.0.1:9080`。`npm run demo` 自动启动另一个仅监听 loopback 的确定性本地模型 stub，使用合成数据，不需要厂商密钥。stub 用于证明协议及运行时控制流，不能代表真实模型的推理质量。

```sh
curl http://127.0.0.1:9080/health
curl http://127.0.0.1:9080/v1/profiles
curl -H 'Content-Type: application/json' http://127.0.0.1:9080/v1/runs \
  -d '{"prompt":"hello generic world"}'
```

随后用响应的 `id`：

```sh
curl http://127.0.0.1:9080/v1/runs/run_REPLACE
curl http://127.0.0.1:9080/v1/runs/run_REPLACE/events?after=0
curl http://127.0.0.1:9080/v1/runs/run_REPLACE/result
curl -X POST http://127.0.0.1:9080/v1/runs/run_REPLACE/cancel
```

`run_REPLACE` 是示意占位符，实际 ID 为 `run_` 加 32 位小写十六进制。

### 带附件的 Skill 流程

```sh
curl -H 'Content-Type: application/json' http://127.0.0.1:9080/v1/files \
  -d '{"name":"sample.txt","content_base64":"QWNjZXB0YW5jZSBkYXRlIGlzIG1pc3Npbmcu"}'
# 将实际返回的 file ID 填入 file_ids。
curl -H 'Content-Type: application/json' http://127.0.0.1:9080/v1/runs \
  -d '{"prompt":"Review the attached document.","profile_id":"document-review","file_ids":["file_REPLACE"]}'
```

默认附件工具只解码 UTF-8 文本；不解析 PDF、DOCX、图片，不执行附件。二进制可上传，但读取时会报工具错误。当前无生成文件下载接口。

## API

完整 OpenAPI 3.1：`openapi.json`，运行时也可 `GET /openapi.json`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 应用健康与实际运行版本 |
| GET | `/v1/profiles` | 已配置的模型、工具、Skills、限额 |
| POST | `/v1/files` | `{name, content_base64}` → 文件 ID |
| POST | `/v1/runs` | `{prompt, profile_id?, file_ids?}` → 202、Run ID |
| GET | `/v1/runs/{id}` | 状态及结构化错误 |
| GET | `/v1/runs/{id}/result` | 成功后的 `{run_id, text}`；其他状态 409 |
| GET | `/v1/runs/{id}/events?after=0` | 增量事件、next_cursor、terminal |
| POST | `/v1/runs/{id}/cancel` | 取消请求；运行中返回 202 cancelling |
| GET | `/v1/runs/{id}/files/{file_id}` | 仅当前 Run 已附文件的元数据 |

事件游标是单 Run 内单调递增的 `seq`，`after` 是排除式游标。事件是 durable headless 投影，不是逐 token SSE，也不是完整 DSH 日志。DSH 上游会截断普通事件的大字符串；final 受本服务总输出字节上限约束。上游 thinking 事件不通过此 API 暴露。后台错误不回传原始 stderr。

客户端不能选择 cwd、任意文件路径、模型 URL、密钥、插件代码或原始 Cordis 配置。未知字段拒绝。没有创建 Run 的幂等键；客户端遇到不确定的 POST 响应，不应盲目重复提交。

## Profile 与扩展

`config/profiles.example.json` 是运维配置。`HARNESS_CONFIG` 可指向其副本。每个 Profile 绑定：

- model：provider 路由名、model ID、OpenAI-compatible `base_url`、密钥环境变量名
- tools：允许的工具名
- skills：从 `skills/<name>/SKILL.md` 复制进该 Run 的 Skill 名称
- system_prompt：通用任务要求
- limits：模型步骤数、单请求最大输出 token、运行墙钟时限
- plugins（可选）：可信部署方提供的 DSH 插件 `{name, config?}`

添加 Skill：在 `skills/new-name/SKILL.md` 写前置元数据与说明，在 Profile 中加入 `skills:["new-name"]` 及 `tools:["skill", ...]`。只复制 SKILL.md；本版没有 Skill 资源包/脚本执行支持。没有默认用户目录或项目目录 Skill 自动发现。

添加工具：安装并审核真实 DSH 插件，或写本地插件，通过 Profile 的 `plugins` 挂载，再把工具名加入 `tools`。示例 `examples/plugins/text-stats.mjs` 展示无需文件、shell 或网络的扩展。其 `name` 应填实际绝对路径，例如 `/app/examples/plugins/text-stats.mjs`。插件由运维信任并完整执行，具有 Node 进程权限；工具名白名单不是不可信插件沙箱。增加 shell/进程/网络工具后必须重做隔离和清理验收。

### 接真实厂商

1. 复制 Profile 配置，明确填写该厂商支持的 OpenAI Chat Completions 兼容 endpoint 与 model ID。
2. 将 `api_key_env` 指向一个专用、由部署方提供的环境变量。配置文件中只保存变量名。
3. 关闭 `HARNESS_DEMO`，以 `HARNESS_CONFIG=/path/profiles.json npm start` 启动。

真实厂商、4A、真实业务材料未验证。本版 API 不提供凭据创建、登录或密钥保存功能，不自动读取旧 DEEPSEEK/OpenAI 密钥。子进程只继承基础路径与当前 Profile 明确指定的密钥变量。不要把密钥写进 URL、prompt、Skill、插件 config 或提交到 Git。模型 endpoint 是运维信任配置；使用真实 endpoint 会把任务、已读附件与工具结果发给该提供方。

## 状态、取消与恢复

状态为 `queued → running → succeeded / failed`。取消为 `running → cancelling → cancelled`；尚未启动的 queued Run 可直接 cancelled。终态重试取消是幂等的。`cancel` 的 ACK 不表示清理完成。

每 Run 独立 Linux 进程组。取消先 SIGTERM，1.5 秒后仍存在则 SIGKILL；主进程 close 后还检查整个进程组。只有确认进程组退出才写 `cleanup=process_group_exited`；不能确认则 `failed/CLEANUP_UNCONFIRMED`。默认工具不会生成子进程；本机制不保证发现可信自定义插件自行逃离进程组的后代。它不是 cgroup/container 沙箱。

成功要求全部满足：DSH exit 0、session opening、final、最后 turn_end.kind=completed。上游失败也可能输出 final，本服务不会把 final 单独当成功信号。超时/输出预算走停止流程后为 failed，而非用户取消。

Run 元数据、事件与结果在 `HARNESS_DATA_DIR`（默认 `./data`）中，DSH session 日志另存每 Run 的私有 home。JSON 原子替换提供单进程落盘，不提供分布式事务或 fsync 级掉电保证。

重启发现未结束的 Run，标记 `interrupted/SERVER_RESTARTED`，不自动重跑，清理状态为 `unknown_after_restart`。硬崩溃可能留下子进程；运维必须先核对并停止旧进程组。数据目录有独占 owner.lock，硬崩溃不会自动移除它，以防误杀 PID 复用或并发写入；确认旧服务及其运行时已停止后，才能手工删除该锁并重启。正常 SIGTERM 会取消活跃任务、等待清理并释放锁。

## 安全边界与限额

- 仅 loopback；不支持改为 0.0.0.0；无 CORS，拒绝 Origin 与非本地 Host。仍需信任能访问该端口/数据目录的本机用户，不能当作鉴权。
- 每文件最多 1 MiB；每 Run 最多 8 个文件；prompt 最多 32,000 字符；JSON body 最大 1,500,000 字节。
- 最多 100 个存储文件、1000 个 Run、2 个并发 Run、16 个排队 Run。无自动 GC；达到限额需停机后归档或使用新数据目录。
- 默认每 Run 8 步、每模型请求 1024 输出 token、60 秒；总 stdout+stderr 最大 2 MiB、事件最多 2000 条。不是账单费用上限。
- 文件名仅展示；实际存储名是随机 ID。读取只查当前 Run manifest，使用 realpath、O_NOFOLLOW、文件类型和尺寸检查。API 没有任意路径下载。
- 默认工具不能读其他 Run、任意宿主路径或发网络请求；模型 adapter 只请求配置 endpoint。底层进程本身没有 OS 级文件/网络隔离。拥有宿主写权限的恶意本机进程不在威胁模型内。
- 返回事件/结果会清理配置密钥的字面量和常见 Bearer/sk-形态。未知秘密、业务隐私无法靠模式匹配保证去除。DSH 私有 session 日志保存模型上下文与工具结果，应按敏感数据保护；不记录 HTTP auth headers 或原始运行时 stderr。这不是任意敏感信息的 DLP 保证。

## 验证与来源

`npm test`：输入、Profile、重启、独占、路径/跨 Run ID/symlink/UTF-8、脱敏。

`npm run test:integration`：真实 DSH + loopback OpenAI-compatible stub，验证普通请求、原生 Skill 加载和工具执行、取消、步骤限额、模型失败。详细结果见 `VALIDATION.md`。

实际执行依赖是 npm 发布物 `@deepseek-ai/dsh@0.2.1-alpha.3`，由 package-lock 的精确版本与 integrity 锁定。官方 tag 对应 `2fbf4359b82fb94c03dcce0b831660d87f12ea5c`；源码审查参考为合并提交 `571902028a75c64c1d767f4ae5fd099485f0ddf0`。没有声称运行物是该合并提交的本地源码构建。见 `SOURCE_REFERENCES.md`。

## Docker 边界

提供 Dockerfile，但当前开发环境无 Docker daemon/CLI，因此没有验证镜像构建或容器运行。不要把 Dockerfile 的存在等同容器隔离验收。

Linux 可先构建，再使用 host network 保留应用的 loopback 监听：

```sh
docker build -t document-review-harness-backend:0.1 .
docker run --rm --network host -e HARNESS_DEMO=1 document-review-harness-backend:0.1
```

容器默认数据只在可写层，退出后可能丢失。持久化时应挂载仅部署用户可读写的数据目录，并测试权限与备份。因为进程只监听容器内 127.0.0.1，普通 `-p` 映射不是受支持启动方式。本版不随附公网部署配置。
