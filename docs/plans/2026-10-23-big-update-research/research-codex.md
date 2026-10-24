# Codex CLI / SDK 调研（为 cli-in-wechat Codex 适配器改造准备）

调研日期：2026-10-23。本地安装：`codex-cli 0.153.0`。线上最新稳定版：**0.164.0**（2026-10-23 发布，npm `@openai/codex` 与 `@openai/codex-sdk` 均为 0.164.0；alpha 已到 0.165.0-alpha.1）。

证据来源分三类：
- 【本地】`codex ... --help` 输出（0.153.0）；`codex app-server generate-ts` 生成的协议类型（0.153.0）；`npm pack @openai/codex-sdk@0.164.0` 解包后的 `README.md`、`dist/index.d.ts`、`dist/index.js`。
- 【官方】https://learn.chatgpt.com/docs/non-interactive-mode （原 developers.openai.com/codex/noninteractive 308 跳转）、https://learn.chatgpt.com/docs/app-server （原 developers.openai.com/codex/app-server）、https://learn.chatgpt.com/docs/codex-sdk 、https://learn.chatgpt.com/docs/config-file/config-basic.md 、https://github.com/openai/codex/releases
- 标 **未核实** 的条目是只在第三方或推断得出、没有在官方/本地源码中确认的。

---

## 1. `codex exec` 现状（0.153 本地 help + 官方文档）

### 1.1 关键参数
| 参数 | 说明 |
|---|---|
| `--json` | stdout 输出 JSONL 事件流（SDK 内部用的是同义的 `--experimental-json`） |
| `-o, --output-last-message <FILE>` | 把最后一条 agent 消息写到文件（stdout 仍照常输出） |
| `--output-schema <FILE>` | JSON Schema 约束最终回答 |
| `-i, --image <FILE>...` | 给首条 prompt 附图片；`exec resume` 也支持 `-i` |
| `-m` / `-p, --profile` / `-c key=value` / `--enable/--disable <FEATURE>` | 模型、profile（0.153 里语义是叠加 `$CODEX_HOME/<name>.config.toml`）、配置覆盖、特性开关 |
| `-s, --sandbox` | `read-only` / `workspace-write` / `danger-full-access`；**exec 默认 read-only**（官方文档） |
| `--approve-for-me` | 新：在 workspace-write 沙箱下把审批请求交给自动审查（Guardian） |
| `--dangerously-bypass-approvals-and-sandbox` | 全放行（yolo） |
| `-C, --cd <DIR>` | 指定工作根目录（SDK 用它，而不是 spawn 的 cwd） |
| `--add-dir`、`--skip-git-repo-check`、`--ephemeral`、`--ignore-user-config`、`--ignore-rules`、`--strict-config`、`--thread-source` | 略 |
| `--full-auto` | **已移除**。官方文档：改用 `--sandbox workspace-write` 或 `--approve-for-me`。（适配器注释说 0.128 移除，具体版本号 **未核实**） |
| `-a, --ask-for-approval` | **只在顶层交互式 `codex` 上存在**，`codex exec` 的 help 中没有。exec 想设置审批策略只能 `-c approval_policy="..."`（SDK 就是这么做的） |

`codex exec` 子命令：`resume`、`fork`（新：按 id 分叉会话）、`review`。

### 1.2 `exec resume`
```
codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
```
- `SESSION_ID` 可以是 UUID 或 thread name；`PROMPT` 为 `-` 时读 stdin。
- `--last`：取**最近一条已记录会话**；help 明确写 `--all` “disables cwd filtering”，即 `--last` 默认**按 cwd 过滤后取最新**。
- resume 子命令自身的 help 里**没有** `--sandbox`/`--profile`/`--add-dir`，但 SDK 的做法是把这些选项放在 `exec` 层、`resume <id>` 之前：`codex exec --experimental-json --sandbox X --cd D -c ... resume <threadId> --image ...`（见 SDK `dist/index.js`）。

### 1.3 `--json` 事件 schema（以 SDK 0.164.0 的 `index.d.ts` 为准，官方文档事件名一致）
顶层事件 `ThreadEvent`：
- `thread.started` `{ thread_id }` —— 第一条事件，**拿到真正的会话 id，用于之后 `resume <id>`**
- `turn.started` `{}`
- `turn.completed` `{ usage: { input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens } }`
- `turn.failed` `{ error: { message } }`
- `item.started` / `item.updated` / `item.completed` `{ item: ThreadItem }`
- `error` `{ message }` —— 不可恢复的流错误

`ThreadItem`（都有 `id`、`type`）：
- `agent_message` `{ text }`（用 output schema 时是 JSON 字符串）
- `reasoning` `{ text }`（推理摘要）
- `command_execution` `{ command, aggregated_output, exit_code?, status: in_progress|completed|failed }`
- `file_change` `{ changes: [{ path, kind: add|delete|update }], status: completed|failed }`
- `mcp_tool_call` `{ server, tool, arguments, result?, error?, status }`
- `web_search` `{ query }`
- `todo_list` `{ items: [{ text, completed }] }`
- `error` `{ message }`（非致命）

### 1.4 配置键
- 推理强度：`model_reasoning_effort`。SDK 0.164 的类型：`"minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent"`（app-server 协议里 `ReasoningEffort = string`）。可用值依模型而定，哪些模型支持 `max/ultra/persistent` **未核实**。exec 下传法：`-c model_reasoning_effort="high"`。
- 联网搜索：官方 config-basic 页面：**顶层 `web_search = "cached"|"indexed"|"live"|"disabled"`**，默认 cached；`[features] web_search` 已废弃。SDK 0.164 传的是 `--config web_search="live"`。适配器当前用的 `-c tools.web_search=live` **官方文档未出现此键**，很可能被忽略（是否完全无效 **未核实**，可用 `--strict-config` 一测）。
- 审批：`approval_policy`，SDK 类型 `never|on-request|on-failure|untrusted`；官方 config 页说 `untrusted` 已 retired（与 SDK 类型冲突，**以运行时为准，未核实**）。
- 沙箱联网：`sandbox_workspace_write.network_access=true`。
- 新的权限 profile 体系：`[permissions.<name>]` + `default_permissions`（`:read-only` / `:workspace` / `:danger-full-access`）。

### 1.5 exec 能不能“在聊天里审批”
不能。exec 是非交互的：没有向调用方回问审批的通道（JSONL 是单向输出）。审批只能事先用 sandbox/approval_policy/`--approve-for-me`（自动审查）决定。要把“是否执行某命令”转给微信用户确认，必须用 app-server。

---

## 2. `codex app-server`（JSON-RPC）

### 2.1 定位
- 官方原话（app-server 页）：“Use it when you want a deep integration inside your own product.” 以及 “If you are automating jobs or running Codex in CI, use the Codex SDK instead.”
- 状态：`codex app-server` 命令仍标 `[experimental]`；官方说 app-server 命令和 WebSocket 传输 “experimental and not supported for production workloads”；生成的 TS/JSON schema 与生成它的 Codex 版本绑定。
- Python SDK 直接基于 app-server JSON-RPC（官方 codex-sdk 页）。官方 SDK 页还写 `codex mcp-server` 和 `codex-mcp-server` 二进制 “have been removed”，让集成方改用 app-server（本地 0.153 还有 `mcp-server`，具体哪一版移除 **未核实**）。
- VS Code 扩展、Desktop app 都走 app-server（help 中 `--analytics-default-enabled` 的说明提到 VSCode 扩展）。

### 2.2 传输与握手
- `--listen stdio://`（默认，JSONL）/ `unix://[PATH]` / `ws://IP:PORT`（实验）/ `off`；另有 `daemon`、`proxy` 子命令（共享本地 daemon）。
- JSON-RPC 2.0 风格，但线上省略 `"jsonrpc":"2.0"`；通知没有 `id`。
- 先发 `initialize { clientInfo: {name,title,version}, capabilities: { experimentalApi?, optOutNotificationMethods?, ... } }`，再发通知 `initialized`。每条连接只初始化一次。

### 2.3 核心方法（本地 generate-ts 确认）
- `thread/start`：`{ model, modelProvider, cwd, approvalPolicy, approvalsReviewer, sandbox, config, baseInstructions, developerInstructions, personality, ephemeral, ... }` → 返回 `thread.id`，随后 `thread/started` 通知。
- `thread/resume`：`{ threadId, model?, cwd?, approvalPolicy?, sandbox?, config?, excludeTurns? }`（推荐用 threadId）。
- `turn/start`：`{ threadId, input: UserInput[], cwd?, approvalPolicy?, sandboxPolicy?, model?, effort?, summary?, outputSchema?, ... }`，返回 `status:"inProgress"` 的 turn。
- `UserInput`：`text`（带 `text_elements`）、`image { url }`、`localImage { path }`、`audio`、`localAudio`、`skill`、`mention`。
- `turn/interrupt { threadId, turnId }` → `{}`，turn 以 `status:"interrupted"` 结束。
- `turn/steer`（运行中追加指令）、`thread/fork`、`thread/rollback`、`thread/compact/start`、`thread/list`、`thread/read`、`thread/archive`、`model/list`、`review/start` 等。

### 2.4 服务端 → 客户端请求（审批）
- `item/commandExecution/requestApproval`：`{ kind, threadId, turnId, itemId, approvalId?, reason?, command?, cwd?, commandActions?, networkApprovalContext?, proposedExecpolicyAmendment?, ... }`
  回复 `{ decision: "accept" | "acceptForSession" | {acceptWithExecpolicyAmendment} | {applyNetworkPolicyAmendment} | "decline" | "cancel" }`
- `item/fileChange/requestApproval`：`{ threadId, turnId, itemId, reason?, grantRoot? }`，回复 `accept|acceptForSession|decline|cancel`
- `item/permissions/requestApproval`（request_permissions 工具，回复授予子集，`scope: "turn"|"session"`）
- `item/tool/requestUserInput`（模型主动提问，带 `autoResolutionMs`）、`mcpServer/elicitation/request`
- 旧版遗留：`execCommandApproval`、`applyPatchApproval`
- 应答后服务端发 `serverRequest/resolved`；turn 结束/中断时未答的 requestUserInput 也会被清理（审批请求在中断时是否同样清理，官方未明说，**未核实**）。

### 2.5 流式通知
`turn/started`、`item/started`、`item/agentMessage/delta { threadId, turnId, itemId, delta }`、`item/reasoning/summaryTextDelta`、`item/reasoning/textDelta`、`item/commandExecution/outputDelta`、`item/fileChange/patchUpdated`、`item/mcpToolCall/progress`、`item/plan/delta`、`turn/plan/updated`、`turn/diff/updated`、`item/completed`、`turn/completed { threadId, turn }`、`thread/tokenUsage/updated`、`thread/status/changed`、`error`、`warning`、`deprecationNotice`、`model/rerouted` 等。
app-server 的 ThreadItem 用驼峰：`agentMessage`、`reasoning {summary[], content[]}`、`commandExecution {command, cwd, status, aggregatedOutput, exitCode, durationMs}`、`fileChange`、`mcpToolCall`、`plan`、`userMessage` ……（与 exec JSONL 的下划线命名不同）。

---

## 3. `@openai/codex-sdk`（TypeScript）

- 版本：**0.164.0**（npm latest，2026-10-23），Node ≥ 18，ESM，Apache-2.0；`dependencies: { "@openai/codex": "0.164.0" }`（会装一份钉死版本的 CLI 二进制；可用 `codexPathOverride` 指向系统 codex）。
- **实现方式（源码确认）**：spawn `codex exec --experimental-json ...`，prompt 写 stdin，逐行解析 JSONL。**不是**走 app-server（第三方博客说 TS SDK 用 app-server，与源码不符）。
- API：
  - `new Codex({ codexPathOverride?, baseUrl?, apiKey?, config?, configOverrides?, env? })`
  - `codex.startThread(ThreadOptions)` / `codex.resumeThread(id, ThreadOptions)`
  - `ThreadOptions`：`model, threadSource, sandboxMode, workingDirectory(--cd), skipGitRepoCheck, modelReasoningEffort, networkAccessEnabled, webSearchMode('disabled'|'cached'|'live'), webSearchEnabled, approvalPolicy, additionalDirectories`
  - `thread.run(input, { outputSchema?, signal?, cyberAccessProgram? })` → `{ items, finalResponse, usage }`
  - `thread.runStreamed(input, opts)` → `{ events: AsyncGenerator<ThreadEvent> }`
  - `thread.id`：第一轮 `thread.started` 后才有值
  - 输入：`string | Array<{type:"text",text} | {type:"local_image",path}>`，图片转成 `--image`
  - 中断：`signal` 直接传给 `child_process.spawn({signal})`，即 abort 时杀进程
- **没有审批回调 API**（官方 SDK 页也没有）。SDK 不提供 `profile`、`ephemeral` 专门选项，需要走 `config`/`configOverrides`（profile 是 CLI flag，SDK 无法传，**需确认是否能用 config 等价替代，未核实**）。

---

## 4. 近期变化 / 破坏性改动

- 0.164.0（2026-10-23，GitHub releases）：升级重试后的工具调用需要重新经过 Guardian 审批（#54263）；macOS 沙箱路径检查更严（#54273、#55384）；`-c` 在多级子命令上设置时都会保留（#56022）；worktree/voice 特性开关移除（#54175）；app-server 的 turn 级 item 分页改为按 turn index（#54351）；最新模型解析输出移除 `modelSlug`（#53745）。release 页本身未标注 “breaking”。
- 已确认的历史变化：`codex exec --full-auto` 移除；`--search` 不再是 exec 参数（只在顶层）；web search 默认开启 cached 模式；`[features] web_search` 废弃，改顶层 `web_search`；`codex mcp-server` 被官方宣布移除（本地 0.153 仍在）；`approval_policy = "untrusted"` 官方称已 retired；`--profile` 改为叠加 `$CODEX_HOME/<name>.config.toml`（0.153 help 中参数名 `CONFIG_PROFILE_V2`，与旧 `[profiles.x]` 表是否兼容 **未核实**）。
- 本地 0.153 落后线上 0.164 共 11 个小版本；SDK 若使用自带二进制则以 0.164 为准。

---

## 5. 当前适配器 `src/adapters/codex.ts` 的问题

1. **`exec resume --last` 会串会话（高风险）**：`--last` 取当前 cwd 下最新的会话。`workDir` 默认是 `process.cwd()`（`src/config.ts`），多个微信用户共用同一目录时，A 的下一条消息会续到 B 刚刚的会话里；本机用户自己在同目录跑交互式 codex 也会被接上。另外保存的 sessionId 是字面量 `'last'`，`/status` 显示的 id 没有意义，无法定位或恢复指定会话。
2. **resume 时丢掉全部设置**：`hasSession` 分支只推 `exec resume --last`，不带 sandbox / bypass / `-m` / web search / add-dir / skip-git-repo-check。官方文档说 exec 默认 read-only，因此 auto 模式用户第二轮起可能变成只读沙箱、或换回默认模型（resume 是否继承原会话的沙箱设置 **未核实**）；非 git 目录下 resume 还可能因缺 `--skip-git-repo-check` 失败（**未核实**）。
3. **web search 配置键可能是错的**：`-c tools.web_search=live` 不在官方文档中；正确写法是 `-c web_search="live"`（SDK 也这么传）。
4. **拿的是原始 stdout**：没有 `--json`，无法区分最终回答/推理/命令输出；失败时退回 stderr 文本；`capabilities.streaming/jsonOutput = true` 名不副实，`onIntermediate` 从未调用，微信端看不到中间进度。
5. **没有推理强度**：`hasEffort:false`，`settings.effort` 被忽略；应接 `-c model_reasoning_effort=...`。
6. **图片走 `buildMediaPrompt` 文本路径**：没用 `-i/--image`，模型实际看不到图片像素（取决于 buildMediaPrompt 实现，大概率只是路径文本）。
7. **审批是全有或全无**：要么 yolo，要么 workspace-write 下由 exec 自动处理，用户无法在微信里批准单条危险命令。
8. 没有 token 用量（`turn.completed.usage`）、没有 `-o` 兜底取最终消息、`isSessionError` 只是文本匹配。
9. 没有 `-C/--cd`，依赖 spawn cwd（可用，但与 SDK 行为不一致）。

---

## 6. 建议方案

**分两步走：**

**第一步（低风险，立刻做）：`codex exec --json` 自己解析，或直接用 `@openai/codex-sdk`**
- 从 `thread.started.thread_id` 取真实 id 存入 `settings.sessionIds.codex`，续聊用 `codex exec [全部选项] resume <id>`，彻底去掉 `--last`。旧数据里的 `'last'` 视为无会话。
- resume 时把 sandbox / bypass / model / effort / web_search / add-dir / skip-git-repo-check 也带上（选项放在 `resume` 之前，照 SDK 的写法）。
- `item.started/completed` 映射到 `onIntermediate`：`command_execution` → tool_use/tool_result，`file_change` → 改了哪些文件，`web_search` → 搜索词，`mcp_tool_call`、`todo_list` → 计划，`reasoning` → `showThoughts` 打开时作为 thinking；最终回答取最后一个 `agent_message`；`turn.completed.usage` 记入结果。
- 推理强度：`-c model_reasoning_effort="<effort>"`，`hasEffort:true`。
- 图片：媒体为图片时改用 `-i <path>`（resume 也支持）。
- 搜索：改 `-c web_search="live"`。
- SDK 和自己解析的取舍：SDK 封装好且类型齐全，但会额外装一份钉死版本的 codex 二进制，不支持 `--profile`、`--ephemeral`，Windows 下有 `.cmd`/Unicode 问题（现在的 `spawnCli` 已经处理过）。**建议自己 spawn `exec --json`，类型直接参照 SDK 的 `index.d.ts`**，或者用 SDK 时把 `codexPathOverride` 指向系统 codex。

**第二步（大改，可选）：app-server 实现“在微信里审批”**
- 每个进程一个长驻的 `codex app-server`（stdio），每个微信用户一个 thread（`thread/start` / `thread/resume`，带 cwd/sandbox/approvalPolicy="on-request"）。
- `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` → 复用现有的 `askUser` 回调问微信用户（允许 / 本会话允许 / 拒绝）→ 回 `decision`；设超时，超时默认 `decline`。
- `item/agentMessage/delta` 等可做流式；`/stop` 对应 `turn/interrupt`；`turn/steer` 支持中途追加指令；`localImage` 原生传图；`effort` 可按 turn 设置。
- 风险：官方明说 app-server 仍是 experimental、不支持生产；协议随版本变化（0.164 刚改了分页），要按版本生成类型并做好容错；需要管理进程生命周期（仓库已有 opencode server 的关闭逻辑可参照）。

**结论**：当前优先级是修 `resume --last` 串会话和 resume 丢设置（真 bug），并接 `--json` 流式事件、effort、`-i` 图片、正确的 `web_search` 键；聊天审批要上 app-server，作为第二阶段，并保留 exec 路径兜底。
