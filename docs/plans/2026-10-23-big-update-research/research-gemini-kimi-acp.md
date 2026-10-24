# 调研：Gemini CLI / Kimi Code CLI 最新状态 + ACP 通用适配器可行性

调研日期：2026-10-23。只读调研，没有改仓库。
方法：从 npm 下载最新发布包（`@google/gemini-cli@0.65.0`、`@moonshot-ai/kimi-code@2.3.1`、`@agentclientprotocol/sdk@2.0.2`、`acpx@0.21.0`），直接读打包后的 JS 源码核对参数和事件格式，再对照官方文档、发布页。本机没装这两个 CLI，所以**没有实际跑过**。凡是没从源码或官方文档直接核对过的条目，都标了「未核实」。

---

## 0. 版本快照（npm registry，2026-10-23 查询）

| 包 | latest | 发布时间 | 备注 |
|---|---|---|---|
| `@google/gemini-cli` | **0.65.0** | 2026-10-20 | preview 0.66.0-preview.0；nightly 0.67.0-nightly.20261024 |
| `@google/gemini-cli-core` | 0.65.0 | 2026-10-20 | 内部核心包，没有稳定的公开 SDK 承诺 |
| `@google/gemini-cli-a2a-server` | 0.65.0 | 2026-10-20 | A2A 协议服务端（不是 ACP） |
| `@google/gemini-cli-sdk` | 不存在 | — | npm 上没有这个包 |
| `@moonshot-ai/kimi-code` | **2.3.1** | 2026-10-23 | TS 重写版，bin=`kimi`，npm 安装要求 Node ≥ 22.19.0（官方脚本装的是单文件二进制，不依赖 Node） |
| `kimi-cli`（PyPI，旧 Python 版） | 1.52.0 | 2026-09-22 | 旧版，新版 `kimi migrate` 可以迁移它的数据 |
| `@agentclientprotocol/sdk` | **2.0.2** | 2026-10-23 | 2.0.0 发布于 2026-10-19，**删掉了旧的 `ClientSideConnection` 等类** |
| `@zed-industries/agent-client-protocol` | 0.4.5 | 2025-10-02 | 已废弃的旧包名 |
| `@agentclientprotocol/claude-agent-acp` | 0.95.0 | 2026-10-23 | Claude Code 的 ACP 适配器（从 `@zed-industries/claude-agent-acp` 迁过来的） |
| `@agentclientprotocol/codex-acp` | 2.2.2 | 2026-10-10 | Codex 的 ACP 适配器（从 `@zed-industries/codex-acp` 迁过来的） |
| `@qwen-code/qwen-code` | 0.26.0 | 2026-10-21 | |
| `opencode-ai` | 1.19.4 | 2026-10-22 | |
| `@github/copilot` | 1.0.103 | 2026-10-22 | |
| `acpx`（openclaw/acpx） | 0.21.0 | 2026-10-24 | 无界面 ACP 客户端 CLI，内置约 30 个 agent 的启动命令，是很好的参考实现 |

---

## 1. Gemini CLI（0.65.0）

### 1.1 重大背景（影响「值不值得继续投入」）
- 官方 headless 文档顶部写着：非付费用户和 Google One 用户已在 **2026-06-18 被迁到 Antigravity CLI**。Google FAQ 也说：从 2026-06-18 起，Gemini CLI 停止为 individuals / Google AI Pro / AI Ultra 档位提供服务；Standard / Enterprise 订阅、付费 API Key、Vertex AI 还能继续用。
  - 来源：https://geminicli.com/docs/cli/headless/ ；https://developers.google.cn/gemini-code-assist/resources/faqs?hl=en ；https://www.shopifreaks.com/google-ends-free-gemini-cli-access-for-non-enterprise-users-on-june-18-replacing-it-with-closed-source-antigravity-cli/
  - 影响：以前靠个人 Google 账号 OAuth 免费用的微信用户，现在大概率直接报认证或配额错误。适配器的报错提示应该加一句「个人免费档已停服，请用 `GEMINI_API_KEY` / Vertex，或改用 Antigravity」。
  - Antigravity CLI 是闭源的 Go 实现。acpx 里有 `antigravity` 条目（`agy_acp_server.par` / `agy_acp_server.exe`），说明它通过 ACP 接入（未核实公开文档）。
- 文档还提示「Gemini CLI 还没针对 Gemini 4 优化，推荐用 Antigravity」。

### 1.2 命令行参数（从 0.65.0 打包源码 `parseArguments` 核实）
- 非交互：`-p/--prompt <text>`，说明是「Appended to input on stdin (if any)」。只要 stdin 或 stdout 不是 TTY，或在 CI 里，就判定为 headless 模式（`isHeadlessMode`）。所以**现在「不带 -p、prompt 走 stdin」的写法还能用**。
- `--output-format/-o`：`text | json | stream-json`。
- `--approval-mode`：`default | auto_edit | yolo | plan`。`--yolo/-y` 和 `--approval-mode` 互斥。
- `--acp`：启动 ACP 模式。`--experimental-acp` 已标为 deprecated。acpx 源码里写着 `--acp` 从 **0.33.0** 起才有，更老的版本只能用 `--experimental-acp`。
- 会话相关：
  - `--resume/-r [latest|序号|uuid]`：不带值等同 `latest`。`findSession` 先按 UUID 精确匹配，再按 1 起算的序号匹配。
  - `--session-id <id>`（**新参数**）：「用指定 ID 新建会话」，只允许 `[a-zA-Z0-9-_]`。
  - `--session-file <path>`：从 JSON 文件加载会话。
  - 上面三个互相排斥。
  - `--list-sessions` / `--delete-session <序号>`。
  - 会话存在 `projectTempDir/chats` 下，**按项目（cwd）隔离**：换了 workDir，旧 ID 就找不到了。
  - 报错文案：`No previous sessions found for this project.`、`Invalid session identifier "..."`。现有的 `isSessionError` 正则都能匹配。
- 其他：`-m/--model`；`-e/--extensions`（数组，逗号分隔）；`--include-directories`（数组，逗号分隔）；`-s/--sandbox`；`--policy` / `--admin-policy`；`--skip-trust`；`-w/--worktree`（需要开实验开关）；`--raw-output`；`--allowed-tools`（已废弃，改用 Policy Engine）。
- nightly 0.67 新增 `models` 子命令和 `--list-models`（来自发布页，未在 0.65 源码中出现）。

### 1.3 致命问题：文件夹信任会把 yolo 悄悄降级
源码（0.65.0）：
```js
const folderTrustSetting = settings.security?.folderTrust?.enabled ?? true;   // 默认开启
...
if (!trustedFolder && approvalMode !== "default") {
  debugLogger.warn(`Approval mode overridden to "default" because the current folder is not trusted.`);
  approvalMode = "default";
}
```
另外，非交互模式下 PolicyEngine 的默认决策是 `deny`。遇到需要 `ASK_USER` 的工具会抛错：`Tool execution for "X" requires user confirmation, which is not supported in non-interactive mode.`
- 结论：如果 bridge 的 workDir 不在 `trustedFolders.json` 里，`--approval-mode yolo` 会被**静默**改回 `default`，写文件、执行 shell 这类工具全部被拒，而且只打一行 debug 日志。
- 解决办法：spawn 时加环境变量 `GEMINI_CLI_TRUST_WORKSPACE=true`（`checkPathTrust` 最先读它，旧版本不认识也不会报错），或者加 `--skip-trust`。注意 yargs 开了 `strict()`，旧版本不认识 `--skip-trust` 会直接退出；这个参数从哪个版本开始有，**未核实**。所以优先用环境变量。

### 1.4 `--output-format json` 的结构（`JsonFormatter.format`）
```json
{ "session_id": "...", "response": "...", "stats": { /* SessionMetrics：models / tools / files */ }, "error": {"type","message","code"?}, "warnings": [...] }
```
- 字段名是 **`session_id`**（现有代码 `r.sessionId || r.session_id` 能兼容）。
- `stats` 是完整的 SessionMetrics，**没有 `duration_ms`**，所以现在的 `r.stats?.duration_ms` 永远是 undefined。
- 在 json 模式下，每遇到一次 `tool_request`，`responseText` 就会被清空（只在遇到 stop_execution 时回退成工具调用前的文本）。所以 `response` 只是**最后一次工具调用之后的文本**，中间的解释性文字都丢了。
- 出错时（`handleError`）会输出 `{session_id, error}` 然后退出，退出码 1 / 42（输入错误）/ 53（超过轮数）。

### 1.5 `--output-format stream-json` 的事件格式（JSONL，源码核实）
| type | 字段 |
|---|---|
| `init` | `timestamp, session_id, model` |
| `message` | `timestamp, role: "user"\|"assistant", content, delta?: true`（assistant 是增量块） |
| `tool_use` | `timestamp, tool_name, tool_id, parameters` |
| `tool_result` | `timestamp, tool_id, status: "success"\|"error", output, error?: {type, message}` |
| `error` | 非致命警告和错误（字段未逐一核实） |
| `result` | `timestamp, status: "success"\|"error", error?: {type,message}, stats: {total_tokens, input_tokens, output_tokens, cached, input, duration_ms, tool_calls, models:{...}}` |

- **不输出 thinking 事件**（枚举里没有 thought）。想在微信里展示 thinking，只能走 ACP（`agent_thought_chunk`）。
- 会话 ID 在第一条 `init` 事件里就有，不用等进程结束。
- 来源：打包源码 `JsonStreamEventType` / `runNonInteractive`；文档 https://geminicli.com/docs/cli/headless/

### 1.6 图片 / @file
- 非交互模式同样会走 `handleAtCommand`，prompt 里的 `@path/to/img.png` 会被展开成文件内容（图片和 PDF 以 inlineData 形式发给模型）。这条是看源码调用链推出来的，**图片具体走哪条路未实测，未核实**。
- 现在的 `buildMediaPrompt` 只在文字里写了路径，还明确叫模型「请勿主动读取」。如果用户就是想让 Gemini 看图，可以对 Gemini 改成生成 `@相对路径`，或者走 ACP 发 `image` 块（ACP 的 `promptCapabilities.image/audio/embeddedContext` 都是 true）。

### 1.7 模型名（`packages/core/src/config/models.ts`）
- 别名：`auto`、`pro`、`flash`、`flash-lite`；`auto-gemini-3`、`auto-gemini-2.5`。
- 具体模型：`gemini-2.5-pro`（DEFAULT）、`gemini-3-pro-preview`、`gemini-3.1-pro-preview`（还有 `-customtools`）、`gemini-3-flash-preview`、`gemini-3.5-flash`、`gemini-3.8-flash`、`gemini-3-flash`、`gemini-3.1-flash-lite`、`gemini-3.5-flash-lite`。
- Thinking：默认 `thinkingConfig.includeThoughts: true`，`DEFAULT_THINKING_MODE = 8192`（thinking budget）。**命令行没有 thinking 参数**，只能通过 settings.json 的 modelConfigs 别名调整（具体写法未核实）。

### 1.8 ACP 模式（`gemini --acp`）
- `initialize` 返回 `protocolVersion: 1`、`loadSession: true`、`promptCapabilities: {image, audio, embeddedContext: true}`、`mcpCapabilities: {http, sse}`、`agentInfo.name = "gemini-cli"`。
- 模式 ID：`default`、**`autoEdit`**（注意和命令行的 `auto_edit` 写法不一样）、`yolo`，开了 plan 时还有 `plan`。也支持模型列表（`availableModels`）。
- 认证：`authenticate` 支持在 `_meta["api-key"]` 里传 API Key，也支持 `_meta.gateway`（baseUrl/headers）。如果走 OAuth，第一次需要交互，否则会卡在 initialize（acpx 设了 15 秒启动超时，并提示用 API Key）。
- `@agentclientprotocol/sdk` 的 README 把 Gemini CLI 的 `zedIntegration.ts` 当作「生产级参考实现」。

### 1.9 编程接口
- `@google/gemini-cli-core` 在 npm 上公开发布，但它是 CLI 的内部核心，API 跟着 CLI 每周变，没有稳定承诺。**不建议直接依赖**，对外的稳定接口是 headless JSON 和 ACP。`@google/gemini-cli-a2a-server` 是 A2A 协议，不是 ACP。

### 1.10 现有 `gemini.ts` 的问题清单
1. **[严重]** 没处理文件夹信任，yolo 在未信任目录下会被静默降级，工具全被拒。→ 在 env 里加 `GEMINI_CLI_TRUST_WORKSPACE=true`。
2. **[严重]** `capabilities.streaming: true` 是假的：用的是 `json` 一次性输出，没有中间消息。→ 改成 `stream-json`，解析 JSONL，把 `message(delta)`、`tool_use`、`tool_result` 映射到 `onIntermediate`。
3. **[中]** json 模式的 `response` 只有最后一段文本；`stats.duration_ms` 不存在（应该用 stream 模式 `result.stats.duration_ms`，或者自己计时）。
4. **[中]** `modes: []`：bridge 的 `/mode` 没法映射。可以映射成 auto→`yolo`、safe→`default`（headless 下等于拒绝所有需要确认的工具，只适合只读）、plan→`plan`。
5. **[中]** 认证错误提示没提「个人免费档 2026-06-18 已停服」。
6. **[低]** 可以改用 `--session-id <uuid>`，由 bridge 预先生成 ID，`--resume` 直接用 UUID，不用依赖输出解析。会话按 cwd 隔离，切换 `/dir` 后应清掉 Gemini 的 sessionId。
7. **[低]** `-e` / `--include-directories` 现在都是数组参数，支持逗号分隔，现有用法兼容。

---

## 2. Kimi Code CLI（`@moonshot-ai/kimi-code` 2.3.1）

仓库：https://github.com/MoonshotAI/kimi-code ；文档：https://moonshotai.github.io/kimi-code/en/ 。旧的 Python 版是 MoonshotAI/kimi-cli（PyPI `kimi-cli` 1.52.0）。

### 2.1 顶层参数（从 2.3.1 打包源码核实）
- `-p, --prompt <prompt>`：非交互。prompt **只能放在 argv**，源码里 print 路径没有读 stdin，文档也没提 stdin。这和现有适配器的假设一致。
- `--output-format <format>`：`choices(["text","stream-json"])`，只在 prompt 模式下有效。也可以用环境变量 `KIMI_MODEL_OUTPUT_FORMAT` 设。
- `-S, --session [id]`（隐藏别名 `-r, --resume`）：prompt 模式下**必须带 id**（`Cannot use --session without an id in prompt mode.`）。
- `-c, --continue`：继续当前目录最近的会话。和 `--session` 互斥。
- `-y, --yolo`：**语义变了**，现在叫「Ask When Needed」（常规操作自动执行，有风险的操作仍会询问）。隐藏别名 `--yes` / `--auto-approve`。
- `--auto`：「Never Ask」，全部自动执行。
- `--plan`：plan 模式。
- `-p` 和 `--yolo/--auto/--plan` 互斥（`Cannot combine --prompt with --yolo.` 等）。文档说 print 模式「不会请求人工审批，普通工具调用按 auto 策略执行，静态 deny 规则仍然生效」。
- `-m, --model <alias>`：用 config.toml 里定义的模型别名。
- `--add-dir <dir>`：可以重复。
- `--agent <name>` / `--agent-file <path>`：不能和 `--session/--continue` 一起用。
- `--skills-dir <dir>`。
- 子命令：`acp`、`web`、`session list [--json --all --cwd]`、`export`、`fork`、`provider`、`login`、`doctor`、`migrate`、`upgrade`、`vis`、`app` 等。
- **`--wire` 已经不存在**（2.3.1 打包里搜不到 `--wire`，那是旧 Python 版的参数）。**也没有 `--thinking` 参数**。
- Thinking：通过 config.toml 的 `[thinking]` 段配置（`effort`、`keep`）；也可以用环境变量 `KIMI_MODEL_THINKING_EFFORT`，但从源码看它只在用 `KIMI_MODEL_NAME` 环境变量定义模型时才生效，**通用性未核实**。ACP 下可以用 `session/set_config_option`（thought_level），或者把模型 ID 写成 `"<id>,thinking"`。

### 2.2 print 模式的输出（源码 `run-v2-print.ts` / `prompt-render`）
- **text 模式**：助手正文写到 stdout，**每块以 `• ` 开头，后续行缩进 2 个空格**（`PromptBlockWriter`）。thinking 也加同样前缀，但写到 **stderr**。stdout 不是 TTY 时不会折行。结束时 stderr 会打印 `To resume this session: kimi -r <sessionId>`，开头还会打 `kimi version x.y.z`。
- **stream-json 模式**（JSONL，OpenAI 消息风格）：
  - `{"role":"meta","type":"system.version","version":"2.3.1"}`
  - `{"role":"assistant","content":"...","tool_calls":[{"type":"function","id","function":{"name","arguments"}}]}`：**一个 step 结束后一次性写出**，不是逐 token 输出。
  - `{"role":"tool","tool_call_id":"...","content":"..."}`
  - `{"role":"meta","type":"turn.step.retrying","failed_attempt",...}`
  - 结尾：`{"role":"meta","type":"session.resume_hint","session_id":"...","command":"kimi -r ...","content":"..."}`
  - 会话被别的进程占用时：`{"type":"error","code":...,"message":...}`，退出码 **4**（`PRINT_EXIT_SESSION_OCCUPIED`）。2.3.1 新增了会话锁，`KIMI_CODE_SESSION_LOCK=0` 可以关掉。
  - **thinking 不写进 JSONL**。工具进度写到 stderr。
- 来源：打包源码；https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html ；changelog https://moonshotai.github.io/kimi-code/en/release-notes/changelog.html

### 2.3 图片
- print 模式的 `-p` 只提交一个 `{type:"text"}` 内容块，**命令行没有附图参数**。模型只能靠 `ReadMediaFile` 工具自己去读工作目录里的图片（0.42.0 起支持 HEIC/HEIF/BMP；0.29.0 起支持视频）。
- ACP 下 `promptCapabilities.image: true`，可以直接发 base64 图片块。

### 2.4 ACP 模式（`kimi acp`，源码核实）
- `initialize` 返回：`loadSession: true`；`promptCapabilities: {image: true, audio: false, embeddedContext: true}`；`sessionCapabilities: {list, resume, close, delete, fork, additionalDirectories}`；`mcpCapabilities: {http, sse}`；`auth.logout`；terminal-auth 方式（`kimi acp --login [--region mainland-cn|global]`）。
- 模式：`default`（手动审批）、`plan`、`auto`、`yolo`。默认是 `default`。
- 审批走标准的 `session/request_permission`，**AskUserQuestion 也映射成 request_permission**（选项就是问题的答案）。请求失败时按拒绝处理。
- 支持 `session/set_config_option`（mode / model / thought_level）、`session/list`、`session/resume`、`session/fork`（unstable）。
- 0.40.0 起 `kimi acp` 一律使用 v2 引擎。

### 2.5 现有 `kimi.ts` 的问题清单
1. **[中]** 输出用的是 `text`：正文带 `• ` 前缀和缩进（适配器注释说去前缀会误伤列表，所以没处理），而且 stdout 为空时会退回到 stderr，把 thinking 或版本号当成答案发出去。→ 改成 `--output-format stream-json`，取 `role:"assistant"` 的 `content`，干净又能拿到工具调用。
2. **[中]** 会话：一律用 `--continue` 哨兵值。微信多用户、多会话共用同一个 cwd 时会**串会话**；2.3.1 有了会话锁以后，并发时还可能直接退出码 4。→ 从 stream-json 的 `session.resume_hint.session_id`（或 text 模式 stderr 的 `kimi -r <id>`）拿到真实 ID，用 `-S <id>` 续接。退出码 4 要单独提示「会话被占用」。
3. **[低]** `capabilities.streaming: false`：stream-json 可以按 step 产出中间消息（assistant 段落、工具调用、工具结果）映射到 `onIntermediate`，粒度是 step 级，不是 token 级。
4. **[低]** `UserSettings.thinking` 字段已经没有命令行参数可以对应了，只能写进 config.toml 或走 ACP。
5. **[低]** mode 固定为 auto 的说法对 print 模式成立；想支持 safe/plan 或微信里审批，只能走 ACP。
6. **[信息]** 注释里「pre-1.x 参数已删除」的说法基本正确；另外 `--yolo` 的语义也变了（0.41.0 改名），以后如果改用交互或 ACP，要注意。

---

## 3. Agent Client Protocol（ACP）

### 3.1 协议与 SDK 现状
- 官网 https://agentclientprotocol.com ；TS SDK https://github.com/agentclientprotocol/typescript-sdk ，npm `@agentclientprotocol/sdk@2.0.2`。
- **SDK 2.0（2026-10-19）有破坏性变化**：默认入口是稳定的 ACP v1；unstable 特性要从 `/unstable` 导入；还有 `/experimental/v2`（v2 草案）。**旧的 `ClientSideConnection` / `AgentSideConnection` 类和实现接口全部删除**，改成 app API：`client({name})`、`onRequest`、`onNotification`、`connectWith(stream, ctx => ctx.request(methods.agent.session.new, …))`。网上多数教程和示例还在用旧 API。来源：包内 `MIGRATION_STABLE_UNSTABLE.md`。
- 线协议是 JSON-RPC 2.0 over stdio（NDJSON），`protocolVersion: 1`。v1 稳定 schema（包内 `schema/v1/schema.json`）的要点：
  - `session/update` 类型：`user_message_chunk`、`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`available_commands_update`、`current_mode_update`、`config_option_update`、`session_info_update`、`usage_update`、`notice`、`compaction_update`、`compaction_summary_chunk`。
  - `session/request_permission`：`options[].kind ∈ allow_once | allow_always | reject_once | reject_always`；返回 `outcome: {outcome:"selected", optionId} | {outcome:"cancelled"}`。客户端发 `session/cancel` 时，必须对挂起的权限请求返回 cancelled。
  - `ImageContent`：`{type:"image", data(base64), mimeType, uri?}`。
  - `StopReason`：`end_turn | max_tokens | max_turn_requests | refusal | cancelled`。
  - 方法：`initialize`、`authenticate`、`session/new|load|list|resume|close|delete`、`session/set_mode`、`session/set_config_option`、`session/prompt`、`session/cancel`；客户端侧有 `fs/read_text_file`、`fs/write_text_file`、`terminal/*`、`elicitation/create`。
- 实测依赖关系：acpx 0.21 依赖 `@agentclientprotocol/sdk ^1.5.0`，engines 要求 node ≥ 22.13；SDK 本身没声明 engines。

### 3.2 哪些 CLI 现在支持 ACP（来源：acpx 0.21.0 内置注册表源码 + 官方页面）
| Agent | 启动命令 | 类型 | 来源 / 核实情况 |
|---|---|---|---|
| Gemini CLI | `gemini --acp`（<0.33 用 `--experimental-acp`） | 原生 | 0.65 源码已核实 |
| Kimi Code | `kimi acp` | 原生 | 2.3.1 源码已核实 |
| Qwen Code | `qwen --acp` | 原生（Gemini CLI 的分支） | acpx 注册表；qwen 0.26 包本身未核实 |
| OpenCode | `opencode acp` | 原生 | acpx 注册表（项目已有 SDK 适配器） |
| GitHub Copilot CLI | `copilot --acp --stdio` | 原生，**public preview** | https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server ；changelog 2026-01-28 |
| Cursor | 官方命令 `agent acp`（acpx 用 `cursor-agent acp`） | 原生 | https://cursor.com/docs/cli/acp ；论坛反馈不支持 `session/list` |
| Claude Code | `claude-agent-acp`（`@agentclientprotocol/claude-agent-acp@0.95.0`） | 适配器 | npm；acpx 记录了 `session/new` 偶发卡死的已知问题 |
| Codex | `codex-acp`（`@agentclientprotocol/codex-acp@2.2.2`） | 适配器 | npm |
| 其他 | Factory Droid（`droid exec --output-format acp`）、Kiro（`kiro-cli-chat acp`）、Qoder（`qodercli --acp`）、iFlow（`iflow --experimental-acp`）、Junie、Kilo、Devin、Trae、Poolside、Antigravity、Goose 等 | — | acpx 注册表；agentclientprotocol.com/overview/agents 列了 49 个 |

### 3.3 能不能用一个通用 ACP 适配器服务多个 CLI？——可行，推荐分阶段做

**收益**
- 一套代码就能覆盖 Gemini、Kimi、Qwen、Copilot、Cursor 等，加一个 CLI 基本只要加一行 argv 配置（acpx 的做法）。
- 统一拿到**真正的流式输出**：`agent_message_chunk`、`agent_thought_chunk`（thinking）、`tool_call` / `tool_call_update`、`plan`，正好对应现有 `IntermediateMessage` 的 thinking / text / tool_use / tool_result。
- **真正的审批**：`session/request_permission` 可以转成微信消息让用户回复「允许 / 拒绝 / 总是允许」，复用现有的 `askUser`（`AskUserRequest`）机制。这样 `/mode safe` 在 Gemini、Kimi 上才有实际意义。Kimi 的 AskUserQuestion 也走这个通道。
- **原生图片**：Gemini、Kimi 都声明 `image: true`，可以把微信图片转 base64 作为 `image` 块直接发，不用再靠「写到工作目录再让模型去读」。
- 会话管理统一：`session/new` 返回 sessionId；`session/load` / `session/resume` 用来续接，不用再解析各家不同的 CLI 输出。
- 模式和模型统一：`session/set_mode`、`session/set_config_option`，加上返回的 `availableModes` / `configOptions`，可以动态生成 `/mode`、`/model` 的可选项。

**风险和成本**
1. **常驻进程管理**：ACP 是长连接的 stdio 子进程。需要按（用户 × agent × workDir）维护进程池，做空闲回收、崩溃重启、优雅关闭（现有 `CLIAdapter.close()` 正好可以用），内存占用比「每条消息 spawn 一次」高。也可以退一步：每条消息 spawn 一次，执行 `initialize → session/load → prompt` 后退出，代价是冷启动慢（Gemini 启动约数秒，acpx 设了 15 秒超时）。
2. **认证**：ACP 下没法完成交互式 OAuth。Gemini 要么提前登录好，要么用 `GEMINI_API_KEY`（也可以通过 `authenticate._meta["api-key"]` 传）。Kimi 要求提前 `kimi login` 或 `kimi acp --login`。initialize / authenticate 要做超时和友好报错。
3. **各家实现差异**：
   - 模式 ID 不统一：Gemini 是 `autoEdit`，Kimi 是 `auto`/`yolo`，Cursor 是 agent/plan/ask。需要按 agent 做映射表，或者按 `availableModes` 动态生成。
   - capability 不一致：Cursor 不支持 `session/list`；Gemini 没声明 `sessionCapabilities`，只有 `loadSession`。
   - `session/load` 会把历史通过 `session/update` **全部重放一遍**，必须在 load 期间屏蔽转发，否则微信会被刷屏。
   - Claude 适配器有已知卡死问题，Copilot 还是 preview。建议 Claude、Codex 继续用现有的原生适配器。
4. **SDK API 变动**：2.0 四天前刚发布，删掉了旧类。要锁定版本（比如 `~2.0.2`），只用稳定的 v1 入口；或者干脆自己写一个很薄的 JSON-RPC 客户端（协议面不大，可以参考 acpx），免受 SDK 变动影响。项目要求 Node 20，SDK 没声明 engines，但 acpx 要 Node ≥ 22，**SDK 2.x 在 Node 20 上能不能跑未核实**。Kimi 走 npm 安装要 Node ≥ 22.19（这是 Kimi 自身的要求，和 bridge 无关）。
5. **审批的交互体验和超时**：微信用户可能很久不回。需要审批超时（超时就 reject 或 cancel）、同一时间只有一个待审批请求、`/cancel` 时对挂起的请求返回 `cancelled`。不声明 `fs` / `terminal` 客户端能力（让 agent 用自己的工具），能减少要实现的接口。
6. **安全**：`allow_always` 会在 agent 侧持久化规则，要向用户讲清楚影响范围；默认档位对应 Gemini `yolo` / Kimi `yolo` 时，行为和现在一致。
7. **Windows**：ACP 的 argv 不含用户文本（prompt 走 JSON-RPC），反而**绕开了 cmd.exe 转义问题**。这比现在的 `-p <prompt>` 安全，但仍需要 `spawnCli` 来解析 .cmd shim。

**建议路线**
- **第一阶段（低风险，马上能做）**：小改现有两个 headless 适配器——Gemini 改成 `stream-json` 并设置 `GEMINI_CLI_TRUST_WORKSPACE=true`；Kimi 改成 `stream-json`，用 `resume_hint.session_id` 配合 `-S <id>`，处理退出码 4。
- **第二阶段**：新建 `src/adapters/acp.ts` 通用适配器，用配置表 `{name, argv, modeMap, env}` 先接 Gemini、Kimi，再加 Qwen、Copilot、Cursor。会话、审批、图片、thinking 统一处理。用户可以通过 `/tool gemini-acp` 这类方式选用，原来的 headless 适配器保留作为兜底。
- 参考实现：acpx（https://github.com/openclaw/acpx ，MIT，包含各 agent 的 quirk 处理：Gemini 版本探测、Copilot `--help` 探测、Claude 超时、Qoder 杂项输出过滤等）；Gemini CLI 的 `zedIntegration.ts`（agent 侧）。

---

## 4. 未核实 / 待实测清单
- Gemini `--skip-trust` 从哪个版本开始有（旧版本加了会因 strict 模式退出）。
- Gemini headless 下 `@image.png` 能不能真的把图片作为 inlineData 发给模型。
- Gemini stream-json 中 `error` 事件的具体字段。
- Gemini thinking 的 settings 写法（modelConfigs 别名覆盖 thinkingBudget）。
- Kimi `KIMI_MODEL_THINKING_EFFORT` 在非环境变量定义的模型上是否生效。
- Kimi `-p` 是否完全不读 stdin（源码里没找到读取 stdin 的路径，文档也没提）。
- Qwen Code 0.26 的 `--acp` 参数（只有 acpx 注册表这一个来源）。
- `@agentclientprotocol/sdk@2.x` 能否在 Node 20 上运行。
- Cursor ACP 是 GA 还是 preview。
- Antigravity CLI 的 ACP 支持程度。

## 5. 主要来源
- npm registry：`https://registry.npmjs.org/<pkg>`（上面各包）；打包源码：`@google/gemini-cli@0.65.0/bundle/*.js`、`@moonshot-ai/kimi-code@2.3.1/dist/main.mjs`、`@agentclientprotocol/sdk@2.0.2`（README、MIGRATION_STABLE_UNSTABLE.md、schema/v1）、`acpx@0.21.0/dist/agent-registry-*.js`、`queue-owner-runtime-*.js`
- https://geminicli.com/docs/cli/headless/
- https://github.com/google-gemini/gemini-cli/releases
- https://developers.google.cn/gemini-code-assist/resources/faqs?hl=en
- https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html
- https://moonshotai.github.io/kimi-code/en/release-notes/changelog.html
- https://github.com/MoonshotAI/kimi-code
- https://agentclientprotocol.com/overview/agents
- https://github.com/agentclientprotocol/typescript-sdk
- https://github.com/openclaw/acpx
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server ；https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/
- https://cursor.com/docs/cli/acp
