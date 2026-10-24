# Claude Code CLI / Claude Agent SDK（TypeScript）最新状况调研 —— 面向 cli-in-wechat 的 Claude 适配器

调研日期：2026-10-23。只读调研，没有改动仓库文件。
对象文件：`src/adapters/claude.ts`、`src/adapters/base.ts`（worktree `big-update-d96b05`）。

## 0. 信息来源

| 来源 | 用途 |
|---|---|
| npm registry：`npm view @anthropic-ai/claude-agent-sdk ...` | 版本号、发布时间、peerDependencies |
| `npm pack @anthropic-ai/claude-agent-sdk@0.3.310` 和 `@0.2.81`，对比两版 `sdk.d.ts`（0.3.310 共 10302 行，0.2.81 共 3970 行） | 类型和选项以这里为准，是一手资料 |
| SDK CHANGELOG：https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md | 每条变更对应的版本号 |
| Claude Code CHANGELOG：https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md | CLI 变更 |
| 官方文档 Streaming Input：https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode | 图片输入、单条消息模式的限制 |
| 官方文档 Permissions：https://code.claude.com/docs/en/agent-sdk/permissions | 权限判定顺序、各模式说明 |
| 本机 `claude --help`，以及用不存在的模型名做的几次 flag 校验探测（本机版本 2.1.300） | CLI flag 的实际行为 |

## 1. 版本现状

- **SDK 最新版：`@anthropic-ai/claude-agent-sdk@0.3.310`**，2026-10-23 发布，对应 `claudeCodeVersion: 2.1.310`。
- **CLI 最新版：`@anthropic-ai/claude-code@2.1.310`**。本机装的是 2.1.300，落后 10 个小版本。
- 0.2.x 线的最后一版是 **0.2.141**（2026-05-13）。从 **0.3.142**（2026-05-14）起进入 0.3.x，SDK 版本号的小版本和 CLI 的 patch 号保持同步。
- **项目写的 `"^0.2.81"`，按 0.x 的 caret 规则等于 `>=0.2.81 <0.3.0`，最高只能装到 0.2.141，永远拿不到 0.3.x。** 想用下面提到的任何新能力，都得手动把依赖改成 `^0.3.310`。
- 0.3.x 的 peerDependencies：`@anthropic-ai/sdk >=0.93.0`、`@modelcontextprotocol/sdk ^1.29.0`、`zod ^4.0.0`（0.3.143 起前两个从 dependencies 挪到 peer）。npm 7+/pnpm/bun 会自动安装，yarn classic 需要手动加。运行时这两个库已经打包在 SDK 内。
- 打包方式变了：0.2.81 自带 `cli.js` 和 `vendor/`；0.3.x 通过 `optionalDependencies` 拉平台原生二进制 `@anthropic-ai/claude-agent-sdk-<platform>`。新增了 `/core` 子入口，体积更小，但不内联 zod 和 MCP SDK。`engines.node >=18`，Node 20 没问题。
- 也就是说，SDK 自带一份 Claude Code 二进制，**不依赖用户本机的 `claude`**。只有 CLI fallback 路径会用到本机的 `claude`。

## 2. 0.2.81 → 0.3.310 的破坏性变更（和本桥接相关的部分）

| 版本 | 变更 | 对本项目的影响 |
|---|---|---|
| 0.2.113 | **Breaking**：`options.env` 改为**替换** `process.env`，不再叠加 | 当前没传 env，不受影响。以后要传必须写成 `{...process.env, X}` |
| 0.2.133 / 0.3.142 | 移除 V2 会话 API（`unstable_v2_*`、`SDKSession`）| 没用到 |
| 0.3.142 | **Breaking**：MCP server 改为后台连接，init 里可能显示 `pending` | 只影响展示 |
| 0.3.142 | **Breaking**：headless/SDK 会话用 `TaskCreate/TaskUpdate/TaskGet/TaskList` 代替 `TodoWrite`；0.3.233/0.3.268 在新模型上默认不再提供任务工具 | `summarizeToolUse` 如果对 TodoWrite 有特殊处理，需要补上新工具 |
| 0.3.162 | 原生构建默认不再单独注册 Grep/Glob 工具 | 工具摘要和 `allowedTools` 里写的 Grep/Glob 可能无效（细节 未核实） |
| 0.3.217 | 子代理默认不再嵌套（深度上限从 5 降到 1，可用 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 调高）| 行为变化，不影响代码 |
| 0.3.234 | `ExitReason` 删除 `bypass_permissions_disabled` | 没用到 |
| 0.3.150 | `api_retry` 遇到 529 报 `overloaded`，不再报 `rate_limit` | 只影响展示 |
| 0.3.200 / 0.3.214 | 新增 `'manual'` 作为 `'default'` 的别名；`set_permission_mode` 遇到未知模式直接报错 | 当前用的 `'default'` 仍然有效 |
| 0.3.286 → **0.3.302** | 不传 `permissionMode` 时：0.3.286 交给 CLI 决定（第三方 provider 或关了遥测时进入 auto）；0.3.302 又改回第三方 provider、关遥测或全新安装时从 `default` 起步 | 当前每次都显式传，不受影响；CLI fallback 的 safe 模式不传，会受影响（见 §5）|
| 0.3.269 | plan 模式下即使设了 `allowDangerouslySkipPermissions`，写操作仍然走 `canUseTool` | plan 模式下 canUseTool 会被调用来审批 Edit/Write，**当前实现会直接 allow，等于 plan 形同虚设**（见 §5）|
| 0.3.300 | 对不能关闭 thinking 的模型，`thinking:{type:'disabled'}` 和 `maxThinkingTokens:0` 按 adaptive 处理 | — |

`query()` 的签名没变：`query({ prompt: string | AsyncIterable<SDKUserMessage>, options })`，返回 `Query`（一个带控制方法的 AsyncGenerator）。当前用法在 0.3.310 下大体还能编译和运行。代码里 `sdkOpts` 写成 `Record<string, unknown>` 再强转，所以就算字段名写错 TS 也不会报错，建议改成 `Options` 类型。

## 3. 0.3.310 的 Options（和桥接相关的字段，取自 sdk.d.ts）

- **权限相关**
  - `permissionMode: 'default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto'`（`auto` 在 0.2.91 加入；`'manual'` 是 `default` 的别名）。
  - `allowDangerouslySkipPermissions`：类型注释写明 bypassPermissions 需要它。SDK 运行时会把它转成 CLI 的 `--allow-dangerously-skip-permissions`。**当前适配器没传这个字段。** 我用 CLI 探测时，`--permission-mode bypassPermissions` 不加这个 flag 也能通过参数校验；但 SDK 路径下不传会不会被拒或降级，**未核实**。建议显式传 `true`。
  - `permissionPrompts: 'host'|'none'`（0.3.259 加入）：`'none'` 表示没人审批，需要提示的操作一律直接拒绝。
  - `canUseTool`、`permissionPromptToolName`、`planModeInstructions`、`disallowedTools`、`additionalDirectories`、`tools`（工具白名单，与 allowedTools 不同）、`toolAliases`。
- **思考与 effort**
  - `effort: 'low'|'medium'|'high'|'xhigh'|'max'`（0.2.81 时还没有 `xhigh`）。
  - `thinking: {type:'adaptive', display?:'summarized'|'omitted'} | {type:'enabled', budgetTokens?, display?} | {type:'disabled'}`。
  - `maxThinkingTokens` 已标 **@deprecated**。
- **会话**
  - `resume`、`resumeSessionAt`（从某条消息处恢复）、`forkSession`、`sessionId`（自定 UUID）、`continue`、`persistSession`、`sessionStore`（alpha）、`title`。
  - 顶层函数：`listSessions({dir,limit,offset,includeWorktrees,includeProgrammatic})`、`getSessionInfo`、`getSessionMessages`、`forkSession()`、`renameSession`、`tagSession`、`deleteSession`（0.2.113）、`listSubagents`、`getSubagentMessages`。
- **流式输出**
  - `includePartialMessages`：开启后输出 `stream_event`（原始 BetaRawMessageStreamEvent）。
  - `forwardSubagentText`（0.2.119）：转发子代理的文本和思考。
  - `includeHookEvents`、`agentProgressSummaries`、`promptSuggestions`。
- **扩展能力**
  - `agents: Record<string, AgentDefinition>`、`agent`（指定主代理）、`mcpServers`（stdio/sse/http/进程内 SDK server）、`strictMcpConfig`、`plugins: [{type:'local',path}]`、`pluginDelivery`、`skills: string[]|'all'`、`hooks`、`sandbox`、`settings`（字符串路径或对象）、`settingSources`。
- **其他**
  - `maxTurns`、`maxBudgetUsd`、`taskBudget`、`fallbackModel`、`outputFormat`（json_schema 结构化输出）、`enableFileCheckpointing`、`env`、`stderr`、`pathToClaudeCodeExecutable`。
  - `verbatimPrompts`：不展开 `@path`，也不分发 `/` 命令；要求 CLI ≥2.1.248。对微信转来的、非用户亲手输入的文本很有用。
  - `onUserDialog` / `supportedDialogKinds`：通用对话框协议，未知的 kind 要回 `cancelled`。
- **systemPrompt**：支持 `string | string[] | {type:'preset', preset:'claude_code', append?, excludeDynamicSections?, snapshot?}`。当前用的 preset+append 写法仍然正确。

### Query 对象上的控制方法（官方文档说这些方法只在流式输入模式下可用）
`interrupt()`（0.3.205 起返回带类型的回执，被截断的 assistant 消息带 `aborted:true`）、`setPermissionMode()`、`setModel()`、`setMaxThinkingTokens()`、`applyFlagSettings()`、`initializationResult()`、`supportedCommands()`、`supportedModels()`、`supportedAgents()`、`mcpServerStatus()`、`getContextUsage()`、`usage_EXPERIMENTAL_...()`、`accountInfo()`、`rewindFiles()`、`streamInput()`、`stopTask(taskId)`、`backgroundTasks()`、`reloadPlugins()`、`reloadSkills()`、`setMcpServers()`、`close()`。

### canUseTool 签名（0.3.310）
```ts
(toolName, input, { signal, suggestions?: PermissionUpdate[], blockedPath?, mcpServer?, decisionReason?,
  title?, displayName?, description?, defaultToNo?, suppressAlwaysAllowRule?, toolUseID?, requestId? /*0.3.199*/ })
=> Promise<{behavior:'allow', updatedInput?, updatedPermissions?, decisionClassification?}
         | {behavior:'deny', message, interrupt?, decisionClassification?}>
```
- `title` 是 CLI 已经拼好的提示句，比如 "Claude wants to read foo.txt"，可以直接发到微信。
- `suggestions` 原样放进 `updatedPermissions`，就实现了"本会话内总是允许"。
- `suppressAlwaysAllowRule` 为 true 时不应该提供"总是允许"选项；`defaultToNo` 为 true 时默认选项应为拒绝。
- AskUserQuestion 的 answers 格式没变：`{ [问题原文]: 答案字符串 }`，多选答案用逗号拼接。当前实现兼容。
- 0.3.198 起：配置 `bypassPermissions`，或 `allowedTools` 里有不带限定符的工具名时，如果同时设了 canUseTool，会发出 Node 进程警告 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`。原因是这些工具会被自动批准，根本不进 canUseTool。当前 auto 模式就会触发这个警告，无害。
- 官方文档：AskUserQuestion **在 bypassPermissions 下也一定会进入 canUseTool**，所以当前"auto 模式下仍能在微信里回答问题"的设计成立。

## 4. 流里的消息类型（SDKMessage 联合类型，0.3.310）

和桥接相关的消息：

| type / subtype | 内容 | 建议用法 |
|---|---|---|
| `system/init` | cwd、session_id、tools、mcp_servers、model、permissionMode、slash_commands、skills、plugins、`effort`（0.3.234）、capabilities | 一开始就拿到 session_id（不用等 result），可以展示模型和模式 |
| `assistant` | `message: BetaMessage`，带 `parent_tool_use_id`、`agent_id`、`subagent_type`、`aborted`、`error`、`usage_report` | **流式过程中每个完成的 content block 会单独发一条 assistant 消息**，多条消息共享同一个 message.id |
| `user` | 携带 tool_result；有 `tool_use_result`（结构化工具输出，Agent 工具的结构化结果是子代理的最终报告）、`parent_tool_use_id` | 用 `tool_use_id` 和 tool_use 对应，不要用"上一个工具名" |
| `stream_event` | 需要开 `includePartialMessages`，内容是原始 SSE 事件（text_delta、thinking_delta 等），附 `ttft_ms` | 实时打字效果；微信场景可以节流后分段发 |
| `result` | subtype `success` 或 `error_during_execution`/`error_max_turns`/`error_max_budget_usd`/`error_max_structured_output_retries`；字段有 `total_cost_usd`、`usage`、`modelUsage{costUSD,inputTokens,...,thinkingTokens}`、`num_turns`、`duration_ms`、`permission_denials[]`、`terminal_reason`、`stop_reason` | 费用和用量汇报；把拒绝原因告诉用户 |
| `system/compact_boundary` | trigger 为 manual/auto，带 pre_tokens/post_tokens | 提示"上下文已压缩" |
| `system/status` | `compacting`/`requesting`/null，带 permissionMode | 状态提示 |
| `system/api_retry` | attempt、max_retries、retry_delay_ms、error | 提示"重试中" |
| `rate_limit_event` | status allowed/allowed_warning/rejected、resetsAt、rateLimitType、utilization | 额度预警（对订阅用户很有用）|
| `system/permission_denied` | tool_name、decision_reason、message | 告诉用户被拒绝的原因 |
| `tool_progress` | tool_use_id、tool_name、elapsed_time_seconds、`heartbeat`（Agent 调用从 0.3.257 起也发）、subagent_type、subagent_retry | 长任务的心跳，可以顺便重置空闲计时 |
| `tool_use_summary` | summary、preceding_tool_use_ids | 现成的工具摘要文本 |
| `system/task_started`/`task_progress`/`task_updated`/`task_notification` | 子代理和后台任务：task_id、tool_use_id、description、subagent_type、usage{total_tokens,tool_uses,duration_ms}、last_tool_name、summary、status | 显示"子代理 X 进行中/完成" |
| `system/thinking_tokens` | estimated_tokens | 思考进度 |
| 其余 | hook_*、notification、memory_recall、prompt_suggestion、files_persisted、auth_status 等 | 可忽略 |

### 子代理（Agent/Task 工具）在流里的样子
- 主代理发出 `tool_use`，name 为 `"Agent"`。BUILTIN_TOOL_NAMES 里叫 `Agent`，旧名 `Task` 经 `LEGACY_TOOL_NAME_ALIASES` 仍可用于规则。本机 2.1.300 的 init 工具列表里显示的还是 `"Task"`，所以两个名字都要处理。改名发生在哪个版本，**未核实**。
- 子代理内部的 tool_use/tool_result 默认也会转发，形式是带 **`parent_tool_use_id` 非空**的 assistant/user 消息。文本和思考只有在开了 `forwardSubagentText` 后才转发。
- 同时还会有 `system/task_started` → `task_progress`（周期性，带 usage 和 last_tool_name）→ `task_notification`（completed/failed/stopped + summary）这一串消息，以及 `tool_progress` 心跳。
- 最后 Agent 工具的 tool_result 出现在主线程的 user 消息里，`tool_use_result` 是 `AgentToolCompletedOutput`（0.3.207 起有公开类型）。
- **当前适配器的问题**：没区分 `parent_tool_use_id`，子代理的每次工具调用都会被当成主线程消息推到微信，刷屏；`pendingToolName` 是单个变量，并行工具调用或子代理交错时，结果会挂到错误的工具名上。

## 5. 当前适配器里过时或有问题的地方

1. **依赖锁死在 0.2.x**：`^0.2.81` 拿不到 0.3.x，xhigh、auto、permissionPrompts、新消息类型等都用不上。要改成 `^0.3.310`，并确认 peer deps（zod 4、@anthropic-ai/sdk、MCP SDK）能装上。
2. **bypassPermissions 没带 `allowDangerouslySkipPermissions: true`**：类型文档写明必须带。不带的运行时后果 **未核实**，建议补上。
3. **"safe" 和 "plan" 模式实际上并不安全**：只要传了 `opts.askUser`，canUseTool 对 AskUserQuestion 以外的工具一律 `allow`。按官方权限流程，default 和 plan 模式下需要审批的调用（plan 模式的 Edit/Write、改文件的 Bash）都会进 canUseTool，也就都被自动放行。**safe 等于 bypass，plan 模式也能写文件。** 这是最严重的问题。正确做法：safe/plan 下把审批请求转发到微信，让用户确认，或者至少在 plan 模式下直接 deny 写操作。
4. **没传 askUser 时**：safe 模式下没有 canUseTool，`permissionPrompts` 默认 `'host'`，需要审批的调用会被拒绝（官方文档：default 模式没有审批手段就拒绝）。这是安全的，但用户只看到"被拒绝"，没有任何提示。建议读 `result.permission_denials` 或 `system/permission_denied` 告诉用户。
5. **图片只当路径塞进文本**：官方文档明确说单条字符串 prompt **不支持直接附图片**。正确做法是改用 AsyncIterable prompt，发 `{type:'user', message:{role:'user', content:[{type:'text',...},{type:'image', source:{type:'base64', media_type, data}}]}, parent_tool_use_id:null}`。现在靠模型自己用 Read 工具去读文件：多一轮工具调用，plan/safe 模式下还可能被权限拦住。
6. **中断只能 abort 整个进程**：`interrupt()`、`setPermissionMode()`、`setModel()` 都需要流式输入模式。现在的 abortController 方案能用，但会杀掉进程，也拿不到 interrupt 回执和被截断的 `aborted` 消息。
7. **工具结果对应关系**：应该用 `tool_use_id` 建 Map，替代 `pendingToolName`；同时过滤掉或折叠 `parent_tool_use_id != null` 的消息。
8. **没有费用和用量**：`ExecResult.cost` 字段已经有，但没从 `result.total_cost_usd` 填进去；`duration` 用的是本地计时，没用 `duration_ms`。
9. **session_id 拿得晚**：只从 result 读。如果中途超时或被取消，session_id 就丢了，下一轮没法 resume。应该在 `system/init`（或任何一条消息的 `session_id`）就记下来。
10. **result 的错误判断**：`subtype !== 'success'` 时会把 `result.result` 当文本，但错误子类型的 result 消息没有 `result` 字段（未核实，从类型看 SDKResultError 不含 `result`），所以会显示"(无输出)"。建议按 subtype 给出中文提示：轮数用尽、预算用尽等。官方文档还说，单条消息模式下出错时 `query()` 会在 yield 完 result **之后抛错**。这会落进当前的 catch，`!sdkAbort.signal.aborted` 时 throw，于是**回退到 CLI 再跑一遍**，等于同一个任务被执行两次。这是隐藏 bug，需要在拿到 result 后吞掉这个异常。
11. **thinking 显示**：新模型默认是 adaptive thinking，`display` 可能是 `omitted`，此时 thinking block 不带文本，"显示思考"功能就没内容。需要传 `thinking:{type:'adaptive', display:'summarized'}`。默认值是不是 omitted，**未核实**。
12. **effort 校验**：用户设置里的 effort 应该限制在 `low|medium|high|xhigh|max`。CLI 遇到未知值会警告后忽略（实测 `--effort ultra` 输出 Warning）。
13. **CLI fallback 里的注释错了**：注释说 `--thinking/--max-turns` 已从 2.x 移除。实测 2.1.300：`--max-turns` 仍然被接受（只是不在 help 里显示；2.1.304 的 changelog 也还提到它）；`--thinking` 仍然存在，可选值为 `enabled|adaptive|disabled`。所以 fallback 路径现在**丢掉了 maxTurns 限制**，可以补回 `--max-turns`。
14. **CLI fallback 的 safe 模式**：不传 `--permission-mode`。2.1.285 到 2.1.301 之间，第三方 provider 或关了遥测的环境会默认进 auto（分类器自动批准）；2.1.302 起改回 default。建议显式传 `--permission-mode default`（或 `manual`）。CLI 的 `--permission-mode` 合法值：`acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`（`default` 作为隐藏别名仍然可用，已实测）。
15. **`settingSources: ['user','project','local']`**：仍然有效，会加载用户的全部插件、技能、钩子和 CLAUDE.md。如果钩子很重，可以考虑 `skills` 或 `plugins` 精确控制。
16. **verbatimPrompts**：微信消息原样当 prompt，如果以 `/` 开头会被当成斜杠命令分发，`@path` 会被展开。目前这算一个功能（可以在微信里跑 /命令），但要意识到这一点；需要原样传递时可以开 `verbatimPrompts`。

## 6. 值得采用的新能力（按对聊天桥接的价值排序）

1. **在微信里真正审批权限**：用 `permissionMode:'default'`（或 `acceptEdits`、`auto`）加 canUseTool。把 `title`/`displayName`/`description` 发给用户，选项为"允许一次 / 本会话总是允许（回传 `updatedPermissions: suggestions`）/ 拒绝（`message` 回给模型，可以 `interrupt:true`）"。要遵守 `defaultToNo` 和 `suppressAlwaysAllowRule`；超时就 deny；用 `options.signal` 处理取消。复用现有 askUser 的微信问答通道就行。
2. **`auto` 模式**：用分类器自动审批，分类器拿不准时才进 canUseTool。比 bypass 安全，比 default 省事，很适合做微信端默认的"智能"档。需要模型和 provider 支持，切到不支持的模型会自动降为 default 并发出 `system/status`。
3. **流式输入模式（AsyncIterable prompt），一个用户对应一个长驻 Query**：
   - 原生图片输入：base64 image block，文档、PDF 可以用 document block；
   - `interrupt()` 实现微信里的"停止"，不用杀进程；
   - 用户在任务进行中又发了消息，可以用 `streamInput` 或 `priority:'now'/'next'` 排队插话；
   - `setPermissionMode()` / `setModel()` 实时切换；
   - 不用每条消息都冷启动进程，延迟更低（另有 `startup()`/`prewarm()` 可用于预热）。
4. **实时流**：`includePartialMessages` 加节流，按句或按 N 秒合并 text_delta 发送；`tool_progress`、`task_progress` 用作心跳，同时重置空闲超时计时器（现在只有收到消息才重置，长时间工具调用可能被误杀）。
5. **费用、用量、额度汇报**：用 result 的 `total_cost_usd`、`modelUsage`、`num_turns`、`duration_ms`；用 `rate_limit_event` 做 5 小时/7 天额度预警；`getContextUsage()` 做 `/context`；`usage_EXPERIMENTAL...` 不稳定，不建议依赖。
6. **会话管理**：`listSessions({dir: workDir, limit})` 做微信端的 `/sessions` 列表（有 summary、lastModified、gitBranch、customTitle）；`renameSession`、`tagSession`、`deleteSession`；`forkSession` 或 `resume` 配合 `forkSession:true` 做"分叉"；`resumeSessionAt` 做"回到某条消息"。`getSessionMessages` 可以做历史回看。0.3.277 起 resume 后费用会继续累计。
7. **子代理展示**：用 `task_started`/`task_notification` 显示"🔧子代理：xxx 开始/完成（N 次工具调用，耗时）"，子代理内部消息折叠起来，只计数。
8. **命令和模型发现**：`supportedCommands()`、`supportedModels()`、`supportedAgents()`、init 里的 `slash_commands`/`skills`，可以给微信 `/help` 动态生成列表。
9. **其他**：`disallowedTools`（SDK 路径目前没传，只有 CLI 路径传了，**属于遗漏**）、`additionalDirectories`（对应设置里的 `addDir`，SDK 路径同样**遗漏**）、`fallbackModel`、`outputFormat`、`hooks`（PreToolUse 可以做硬性拦截，比如禁止 `sudo`，正好对付现有注释里提到的 sudo 卡死问题）、`sandbox`。

## 7. CLI flag 现状（2.1.300 实测 + 2.1.310 changelog）

- 仍可用：`-p`、`--output-format stream-json`、`--verbose`、`--input-format stream-json`（支持实时流式输入和图片内容块）、`--include-partial-messages`、`--include-hook-events`、`--forward-subagent-text`、`--replay-user-messages`、`--resume/-r`、`--continue/-c`、`--fork-session`、`--session-id`、`-n/--name`、`--effort low|medium|high|xhigh|max`、`--model`（别名 `fable`/`opus`/`sonnet`）、`--fallback-model`、`--max-budget-usd`、`--allowedTools`/`--disallowedTools`、`--tools`、`--add-dir`、`--append-system-prompt`/`--system-prompt`、`--system-prompt-snapshot`、`--mcp-config`、`--strict-mcp-config`、`--setting-sources`、`--settings`、`--plugin-dir`、`--agents`、`--agent`、`--bare`、`--safe-mode`、`--restricted`、`--permission-prompts host|none`、`--json-schema`、`--no-session-persistence`、`--dangerously-skip-permissions`、`--allow-dangerously-skip-permissions`。
- 隐藏但仍有效：`--max-turns`（实测接受）、`--thinking enabled|adaptive|disabled`（实测有校验）。
- `--permission-mode` 合法值：`acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`；`default` 是隐藏别名。
- 新增的运维类命令：`claude agents/attach/logs/rm/respawn`、`--bg` 后台会话、`--desktop`、`--cloud`。和桥接无直接关系。
- 2.1.300 删除了 `claude remote-control` 的 `--sandbox/--no-sandbox`，和桥接无关。
- 2.1.302：没有指定权限模式的 `-p` 和 SDK 会话，在第三方 provider、关遥测或全新安装时从 default 起步。

## 8. 未核实清单
- SDK 路径下 bypassPermissions 不带 `allowDangerouslySkipPermissions` 的实际运行时行为。
- 新模型上 adaptive thinking 的默认 `display` 是不是 `omitted`（会影响"显示思考"功能）。
- `Task` → `Agent` 改名发生在哪个版本；目前 tool_use block 里实际用哪个名字（类型里是 Agent，2.1.300 的 init 列表显示 Task）。
- SDKResultError 是否一定没有 `result` 文本字段（类型定义里没看到）。
- 0.3.162 去掉 Grep/Glob 之后，`allowedTools` 里写 Grep/Glob 的效果。
- 0.3.0–0.3.141 这些版本在 CHANGELOG 里没有条目（从 0.2.141 直接跳到 0.3.142）。
