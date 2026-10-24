# 长尾终端编程 Agent CLI 全景调研（截至 2026-10-23）

> 目的：为 cli-in-wechat 规划“还能接哪些 CLI、怎么低成本地接”。只读调研，未改仓库。
> 已支持：Claude Code、Codex、Gemini CLI、Kimi、OpenCode。Qwen Code / Cursor CLI / Copilot CLI / Amp / Crush / Aider 由另一位调研者深挖，本文只各给一行。
> 标注：**未核实** = 只见于二手资料或没跑过 `--help`；数字为 2026-10-23 当天用 `gh api` / npm / pypistats 拉取。

---

## 0. 关键结论（先看这个）

1. **ACP 已经成了事实标准。** 官方 ACP Registry（`github.com/agentclientprotocol/registry`）目前收录 **46 个** agent，Zed 和 JetBrains 都直接从里面装。Devin、Factory Droid、Antigravity、Junie、Kiro、Goose、Cline、Auggie、Mistral Vibe、Grok Build、Kilo、Qoder、CodeBuddy、MiniMax Code、Kimi Code、Qwen、Copilot、Cursor、OpenCode、Gemini、Codex(适配器)、Claude(适配器)、pi(适配器)、OpenHands 都能走 ACP。
   → **写一个通用 ACP 适配器，就能用“命令 + 参数”配置一次性覆盖 30 多个 CLI**，性价比最高。
2. **stream-json 方言收敛到“类 Claude”格式。** Antigravity `agy`、CodeBuddy、Qoder、Letta、Factory Droid、Kimi Code、ZCode、Goose、Cline(`--json`)、Grok(`streaming-json`)、Mistral Vibe(`--output streaming`)、OpenHands(`--json`)、Junie(`json`) 都有 JSONL/JSON 输出，但字段各不相同。→ 做一个**配置驱动的通用 JSONL 适配器**（用 JSONPath 映射字段），可以兜住没有 ACP 或 ACP 不稳的 CLI。
3. **⚠️ 影响现有适配器的两件事：**
   - **Gemini CLI**：2026-06-18 起 Google 停止为**个人账号**（免费 / AI Pro / Ultra）提供 Gemini CLI 服务，个人用户被迁到闭源的 **Antigravity CLI（`agy`）**。付费 API key 和企业版 Code Assist 不受影响（来源都是二手，**未核实官方原文**）。→ 应该新增 `agy` 适配器（它有 `-p --output-format stream-json`，也有 ACP），并在 Gemini 适配器的报错提示里引导用户换用。
   - **Kimi**：旧的 Python 版 `MoonshotAI/kimi-cli` 已于 2026-09 **归档**，新版是 **Kimi Code CLI**（`MoonshotAI/kimi-code`，npm `@moonshot-ai/kimi-code`，命令仍是 `kimi`，周下载 7.1 万）。新版支持 `kimi -p ... --output-format stream-json` 和 `kimi acp`。我们的 `kimi.ts` 现在用 `--output-format text`，可以升级成 stream-json，或者直接改走 ACP。
4. **已死或停滞，别做：** iFlow CLI（阿里心流，公告 2026-04-17 停服、引导迁到 Qoder，**未核实官方原文**）；Roo Code（仓库 2026-05 归档）；Plandex（最后一次推送 2025-10）；Amazon Q Developer CLI（2025-11 已改名为 Kiro CLI，旧仓库只修安全问题）；Jules Tools CLI（npm 最后发版在 2025-12，是云端异步任务模式，不适合做对话桥）。
5. **国产里真正可用的 CLI：** CodeBuddy Code（腾讯，周下载 13.2 万，有 stream-json 和 ACP）、Kimi Code（月之暗面）、Qwen Code（阿里）、Qoder CLI（阿里，有 stream-json 和 ACP）、MiniMax Code（`mcode`，有 exec 和 ACP）、ZCode（智谱，2026-09 开源，有 stream-json）。百度 Comate、通义灵码 Lingma、字节 TRAE（IDE 版）、阶跃、DeepSeek **没找到官方 headless CLI**。

---

## 1. 总表（分层 + 关键 flag）

层级定义：
**T0** = 支持 ACP → 通用 ACP 适配器，每个 CLI 只要一份命令配置；
**T1** = 有 stream-json / JSONL 的 headless 模式 → 写小型专用适配器，或用配置驱动的通用 JSONL 适配器；
**T2** = 只有纯文本 headless → 通用文本适配器；
**T3** = 没有可用的 headless / 只能在 IDE 里用 → 不支持。
一个 CLI 可以同时属于 T0 和 T1，表里写的是推荐走哪条路。

| CLI | 厂商 | 最新版本（日期） | 热度 | Headless 调用 | 机器可读输出 | ACP 启动命令 | 推荐层级 |
|---|---|---|---|---|---|---|---|
| **Antigravity CLI `agy`** | Google | 1.4.7（2026-10-24） | 仓库 2.6k★（闭源二进制） | `agy -p "<prompt>"` | `--output-format json\|stream-json`，`--input-format stream-json` | Registry 有 `antigravity-acp` 1.4.3（独立的 `agy_acp_server`） | **T1 一等公民**（Gemini 的继任者） |
| **Devin CLI** | Cognition | 3000.11.205（2026-10-23） | npm `devin` 453/周（新品） | `devin -p -- <prompt>` | print 模式**没有文档化的 JSON 流**（只有 `--export` ATIF） | `devin acp [--model]` | **T0** |
| **Factory Droid** | Factory | 0.249.0（2026-10-24） | npm `droid` 5.9k/周 | `droid exec "<prompt>"` | `-o text\|json\|stream-json\|stream-jsonrpc`（stream-json 已标记弃用） | `droid exec --output-format acp-daemon` | T0（或 T1） |
| **pi**（pi-mono） | Mario Zechner / Earendil | 1.4.0（2026-10-21） | 117k★；npm `@earendil-works/pi-coding-agent` **287 万/周** | `pi -p` / `--mode json` | `--mode json`（JSONL 事件），`--mode rpc`（stdin/stdout 双向 JSONL） | 第三方适配器 `pi-acp`（npx） | **T1 一等公民**（RPC 模式） |
| **Kiro CLI** | AWS | 2.x（2.0 于 2026-04 发布） | 闭源 | `kiro-cli chat --no-interactive "<prompt>"` | 只有文本（第一条回复写到 stdout）**未核实是否有 JSON** | 有（kiro.dev/docs/cli/acp） | T0 |
| Amazon Q Dev CLI | AWS | v1.19.7（2025-11，冻结） | 2.0k★ | `q chat --no-interactive` | 文本 | 无 | 已被 Kiro 取代，跳过 |
| **Warp Oz CLI** | Warp | 滚动发布 | Warp 仓库 65.7k★ | `oz agent run --prompt "..."` | **未核实**（文档只给 `whoami` 写了 `--output-format json`） | 无 | T2（低优先级，需要 `WARP_API_KEY`） |
| **Goose** | Block → AAIF | 1.56.0（2026-10-23） | 55.6k★ | `goose run -t "<prompt>"` | `--output-format text\|json\|stream-json` | `goose acp` | T0（或 T1） |
| **Cline CLI** | Cline | 3.0.73（2026-10-22） | 70.8k★；npm 4.8 万/周 | `cline --json "<task>"` | NDJSON（`agent_event`、`run_result`） | `cline --acp` | T0 |
| **Auggie** | Augment | 0.36.0（2026-10-23） | npm 1.9 万/周 | `auggie --print "<instr>"` | `--output-format json`（**没有** stream-json） | `auggie --acp` | T0 |
| **OpenHands CLI** | OpenHands | 1.16.0（2026-05） | 主仓库 91.7k★；PyPI `openhands` 2.9 万/周 | `openhands --headless -t "<task>"` | `--json`（JSONL：action/observation） | `openhands acp` | T0 |
| **Junie CLI** | JetBrains | 3813.9.0（Registry） | 闭源 | `junie --auth=$KEY "<task>"` | `--output-format text\|json`，`--json-output-file` | `junie --acp=true` | T0 |
| **Mistral Vibe** | Mistral | 3.0.2（2026-10-22） | 5.2k★；PyPI **63 万/周** | `vibe --prompt "<p>" --auto-approve` | `--output text\|json\|streaming`（NDJSON） | Registry 有独立的 `vibe-acp` 二进制 | T0（或 T1） |
| **Grok Build** | xAI | 1.0.70（npm `@xai-official/grok`） | `xai-org/grok-build` 27.5k★；npm 5.8 万/周 | `grok -p "<p>"` | `--output-format plain\|json\|streaming-json` | `grok agent stdio` | T0（或 T1） |
| grok-cli（社区版） | superagent-ai | — | 3.5k★ | — | — | — | 已被官方版取代，跳过 |
| **Letta Code** | Letta | 0.34.23（2026-10-23） | 3.7k★；npm 4.1 万/周 | `letta -p "<p>"` | `--output-format stream-json`；`--input-format stream-json`（双向，带 `can_use_tool`） | 无 | **T1**（几乎就是 Claude 方言） |
| Plandex | Plandex | cli/v2.2.1（2025-07） | 15.8k★（已停滞） | — | — | 无 | T3（停更） |
| **Continue CLI `cn`** | Continue | @continuedev/cli 1.5.47（2026-06） | 主仓库 36.3k★；npm 2.9k/周 | `cn -p "<p>"` | `--format json` | **未核实** | T1/T2（低优先级） |
| **Kilo CLI** | Kilo | 7.8.17（2026-10-23） | 27.7k★；npm 2.1 万/周 | `kilo run --auto "<msg>"` | `--format json`（**未核实**完整格式） | `kilo acp` | T0 |
| Roo Code | Roo | — | 24k★（**已归档**） | — | — | — | T3 |
| Jules Tools | Google | 0.1.42（2025-12） | npm 1k/周 | `jules remote new --repo ... --session "..."` | 文本 | 无 | T3（云端异步，不适合做对话） |
| **Rovo Dev CLI** | Atlassian | — | 闭源，按订阅收费 | `acli rovodev run "<instr>" --yolo` | 文本（有第三方说 prompt 限 256 字，**未核实**） | **未核实** | T2 |
| **Poolside `pool`** | Poolside | 1.0.16（2026-08） | 440★ | `pool exec` | **未核实** | `pool acp` | T0 |
| **IBM Bob** | IBM | 2.0.9 | npm 359/周 | — | — | `bob acp` | T0（企业向） |
| **Snowflake Cortex Code** | Snowflake | 1.0.73 | — | — | — | `cortex acp serve` | T0（垂直领域） |
| **VT Code** | vinhnx | 0.180.5（2026-10-22） | 887★ | `vtcode exec "<p>"`；`vtcode exec resume --last` | **未核实** | `vtcode acp` | T0 |
| **Stakpak** | Stakpak | 0.3.88 | 1.8k★ | — | — | `stakpak acp` | T0（偏 DevOps） |
| **Dirac** | dirac-run（Cline 分支） | 0.5.23 | 1.5k★ | `dirac --yolo "<task>"` | 纯文本 | `dirac --acp` | T0 |
| **Kimchi** | getkimchi（基于 pi） | 1.21.0 | 2.3k★ | — | — | `kimchi --mode acp` | T0 |
| Docker Agent（cagent） | Docker | 1.152.0 | 4.6k★ | `docker agent run` | — | 支持（Registry 文档有列） | T0 |
| DeepAgents / fast-agent / crow-cli / DimCode / Nova / Autohand / Corust / Harn / siGit / Minion / Agoragentic | 各家 | — | 都 <5k★ | — | — | 都在 Registry 里（npx / uvx / binary） | T0（长尾，靠 Registry 自动发现） |
| Hermes Agent | Nous Research | v0.22.5 | **256k★** | — | — | 支持 ACP | 通用个人 agent（同时是同类“聊天桥”竞品），可走 T0 |
| OpenClaw | OpenClaw 基金会 | v2026.10.6 | **393k★** | — | — | `openclaw acp` | 通用个人 agent / 竞品；可走 T0 |
| Zed | Zed | 1.0（2026-04） | — | — | — | Zed 是 ACP **客户端**，不是 agent | 不适用 |
| — 另一位调研者负责 — | | | | | | | |
| Qwen Code | 阿里 | 0.26.0 | 28.7k★；npm 4.8 万/周 | `qwen -p` | stream-json | `qwen --acp` | T0/T1 |
| Cursor CLI | Cursor | 2026.10.22 | 闭源 | `cursor-agent -p` | stream-json | `agent acp` | T0/T1 |
| Copilot CLI | GitHub | 1.0.103 | npm **130 万/周** | `copilot -p` | JSON | `copilot --acp` | T0 |
| Amp | Sourcegraph | 滚动发布 | npm 1.6 万/周 | `amp -x` | `--stream-json` | 第三方 `amp-acp` | T1/T0 |
| Crush | Charm | 0.98.2 | 28.8k★ | `crush run` | 文本 | 无 | T2 |
| Aider | Aider-AI | — | 49.7k★；PyPI 6.4 万/周 | `aider --message --yes-always` | 文本 | 无 | T2 |

### 国产（中国厂商）

| CLI | 厂商 | 最新版本（日期） | 热度 | Headless 调用 | 机器可读输出 | ACP | 国内可用？ | 推荐层级 |
|---|---|---|---|---|---|---|---|---|
| Qwen Code | 阿里通义 | 0.26.0 | 见上 | — | — | ✓ | ✓ | 另一位调研者负责 |
| **CodeBuddy Code**（`codebuddy` / `cbc`） | 腾讯云 | 2.174.0（2026-10-23） | npm **13.2 万/周**（国产第一） | `codebuddy -p "<p>"` | `--output-format text\|json\|stream-json`，`--input-format stream-json`，`--include-partial-messages` | `codebuddy --acp` | ✓（有国内版和国际版） | **T1 一等公民**（几乎照抄 Claude 的 flag，可以复用 claude.ts 的解析） |
| **Kimi Code CLI**（`kimi`） | 月之暗面 | 2.3.1（2026-10-23） | npm 7.1 万/周 | `kimi -p "<p>"` | `--output-format text\|stream-json`（思考内容不写进 JSONL） | `kimi acp` | ✓ | 已支持 → **升级现有适配器** |
| **Qoder CLI**（`qodercli`） | 阿里（Qoder） | npm 1.1.78（Registry 0.2.14） | npm 5.6k/周 | `qodercli -p "<p>"` | `--output-format text\|json\|stream-json`，`--input-format stream-json` | `qodercli --acp` | 面向海外为主，**国内可用性未核实** | T1/T0 |
| **MiniMax Code**（`mcode`） | MiniMax | v0.6.13（npm） | 2.1k★；npm 6.5k/周 | `mcode exec "<p>"` | **未核实**（README 没写 JSON 格式） | `mcode acp` | ✓（`--region` 可选 global / cn**未核实**） | T0 |
| **ZCode**（`zcode`） | 智谱 Z.ai | v3.16.2（2026-10-19） | 8.2k★ | `zcode --prompt "<p>" --cwd ... --mode ...` | `--output-format json\|stream-json`；`--resume <id>` | **未核实**（Registry 里有第三方的 `glm-acp-agent`） | ✓ | T1（目前要从源码构建，或用 install.sh**未核实**） |
| GLM ACP Agent | 社区（stefandevo） | 1.15.0 | 68★ | — | — | npx `glm-acp-agent` | ✓（用 GLM Coding Plan） | T0（长尾） |
| Z.ai coding-helper | 智谱 | `@z_ai/coding-helper` 0.1.1 | npm 1.1k/周 | 只是给 Claude Code 等工具配置 GLM 的助手，不是 agent | — | — | — | 不适用（但 GLM Coding Plan 可以作为 Claude 适配器的“模型源”） |
| iFlow CLI | 阿里心流 | 0.5.19（2026-05） | 5.1k★；npm 279/周 | `iflow -p` | — | 曾支持 | **已停服**（2026-04-17，**未核实官方原文**） | 跳过 |
| Trae Agent（`trae-cli`） | 字节 | 无 release；最后推送 2026-02 | 12.2k★ | `trae-cli run "<task>" --trajectory-file x.json` | 轨迹 JSON 文件（不是流） | 无 | ✓（BYOK，可用豆包） | T2（偏研究性质，低优先级） |
| TRAE CLI / TRAE SOLO（IDE） | 字节 | — | — | **没找到官方 headless CLI** | — | — | — | T3 |
| 百度文心快码 Comate | 百度 | — | — | 宣传里有“智能 CLI”，但**没找到可 headless 调用的 CLI** | — | — | ✓ | T3（**未核实**） |
| 通义灵码 Lingma | 阿里云 | — | — | 只有 IDE 插件和 Lingma IDE，**没找到 CLI** | — | — | ✓ | T3 |
| 阶跃 StepFun / DeepSeek | — | — | — | 没有官方编程 CLI（DeepSeek 只是“模型源”，可以接进 Claude / OpenCode 等） | — | — | — | 不适用 |
| MiniMax Mini-Agent | MiniMax | 2026-02 | 3.1k★ | 演示项目 | — | — | — | 跳过 |

---

## 2. 逐个详情（会话 / 权限 / 认证 / 许可证）

### 国际

- **Antigravity CLI（`agy`）**：安装 `curl -fsSL https://antigravity.google/cli/install.sh | bash`。`-p/--print/--prompt` 都是 print 模式。`--output-format stream-json` 输出强类型的 NDJSON，事件有 `init`、`step_update`、终止事件 `result`，`step_type` 是封闭枚举。还支持 `--json-schema`；`--input-format stream-json` 可以在一个进程里跑多轮。会话恢复：`-c/--continue`、`--conversation <id>`。权限：`--mode accept-edits|plan`、`--dangerously-skip-permissions`（1.3.2 起不再自动批准 plan）。退出码：模型或 agent 出错时退出码 3，并打印 `AGY_ERROR` 行。旧版在非 TTY 下 `-p` 会卡住（issue #76/#318），近期 release 修了多处 headless 问题，**需实测**。认证走 Google 登录（keyring），也可以在 settings 里设 `modelProvider: gemini` 再用 `GEMINI_API_KEY`。闭源。国内需要代理才能用 Google 服务。
  来源：https://github.com/google-antigravity/antigravity-cli （releases 1.1.8 起有 output-format）、https://computingforgeeks.com/antigravity-cli-cheat-sheet/ 、https://github.com/google-antigravity/antigravity-cli/issues/318
- **Devin CLI**：`npm i -g devin`，也有 curl 脚本 / brew；Rust 写的。`-p/--print`，`--prompt-file`；脚本里要加 `--respect-workspace-trust false`。会话：`-c`、`-r <id>`，`--cloud -r <url>`。权限：`--permission-mode normal|accept-edits|smart|dangerous(yolo)|autonomous(需要 --sandbox)`。ACP：`devin acp [--model]`，读取 `WINDSURF_API_KEY`。需要 Devin / Windsurf 账号，闭源。print 模式没有 JSON 流，所以**走 ACP**。
  来源：https://docs.devin.ai/cli/reference/commands.md
- **Factory Droid**：`droid exec` 默认只读；`--auto low|medium|high` 或 `--skip-permissions-unsafe`。会话：`-s/--session-id`、`--fork`。输出：`-o stream-jsonrpc`（官方推荐用于多轮，stream-json 已弃用）。ACP 官方 Registry 用的是 `droid exec --output-format acp-daemon`。需要 Factory 账号（有 BYOK）。npm 包的许可证写的是 UNLICENSED（闭源）。
  来源：https://docs.factory.ai/droid-exec/overview.md 、https://docs.factory.ai/droid-cli/cli-reference
- **pi**：`npm i -g --ignore-scripts @earendil-works/pi-coding-agent`（旧包 `@mariozechner/pi-coding-agent` 已停更），要求 Node ≥22.19。`--mode json` 先输出 session header，再输出 JSONL 事件；`--mode rpc` 是长驻进程，命令和事件都是 JSONL，**分帧只能按 LF 切，Node 的 `readline` 会误切 U+2028/2029**。其他 flag：`--provider`、`--model`、`--no-session`、`--session-dir`。**没有内置权限系统**（以当前用户权限运行，桥接时要提醒用户）。可以 `/login` 订阅或用 API key。MIT。也可以在 Node 里直接 `import { AgentSession }` 内嵌，不用起子进程。
  来源：https://github.com/earendil-works/pi-mono 、https://pi.dev/docs/latest/cli-integration 、https://unpkg.com/@earendil-works/pi-coding-agent@0.83.0/docs/rpc.md
- **Kiro CLI**：headless 是 `kiro-cli chat --no-interactive "<p>"`，配 `--trust-all-tools` 或 `--trust-tools=read,grep`。用 `KIRO_API_KEY` 认证，**只有 Pro / Pro+ / Power 订阅才有 API key**。headless 下不能中途再输入。闭源（AWS IP License）。中国区可用性**未核实**。
  来源：https://kiro.dev/docs/cli/headless/ 、https://kiro.dev/blog/introducing-headless-mode/ 、https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/upgrade-to-kiro.html
- **Goose**：`goose run -t/-i`、`-q`、`--output-format stream-json`、`-n <name>` 加 `-r` 恢复、`--no-session`、`--max-turns`。ACP：`goose acp`，无人值守时设 `GOOSE_DISABLE_KEYRING=1`。BYOK，支持 15+ 个 provider。Apache-2.0。
  来源：https://goose-docs.ai/docs/guides/goose-cli-commands 、https://www.mankier.com/1/goose-run
- **Cline CLI**：`npm i -g cline`。`--json` 输出 NDJSON（`type: agent_event | run_result`…）。其他 flag：`--auto-approve true|false`（默认 true）、`-p/--plan`、`-m`、`-P`、`-c <cwd>`、`--thinking`、`-t <timeout>`。文档里没写恢复会话的 flag。ACP：`cline --acp`。需要先 `cline auth`（Cline Provider 或 BYOK）。Apache-2.0。另有 `@cline/sdk`。
  来源：https://docs.cline.bot/cline-cli/overview 、https://github.com/cline/cline
- **Auggie**：Node 22+。`--print`、`--output-format json`、`--quiet`、`--max-turns`、`-c`、`--resume <id>`、`--permission <rule>`、`--acp`。认证：`AUGMENT_SESSION_AUTH` 或 `--augment-session-json`。需要 Augment 账号（有付费额度）。许可证是自定义的。
  来源：https://docs.augmentcode.com/cli/reference.md
- **OpenHands CLI**：`uv tool install openhands`。`--headless -t/-f`，`--json` 输出 JSONL；headless 下**固定 always-approve**。`--resume [<id>|--last]`。ACP：`openhands acp`。默认忽略 `LLM_API_KEY` 等环境变量，要加 `--override-with-envs`。MIT。
  来源：https://docs.openhands.dev/openhands/usage/cli/headless 、https://github.com/OpenHands/OpenHands-CLI
- **Junie CLI**：`--auth`、`--output-format json`、`--json-output-file`、`--input-format`、`--session-id`、`--project`、`--model`、`--timeout`。ACP：`--acp=true`。2026-03 进入 beta，GA 时间**未核实**。可以接任意 LLM（BYOK），也有 JetBrains AI 订阅。
  来源：https://junie.jetbrains.com/docs/parameters.html 、https://junie.jetbrains.com/docs/junie-headless.html
- **Mistral Vibe**：`uv tool install mistral-vibe`。`--prompt`、`--output streaming`、`--max-turns`、`--max-price`、`--enabled-tools`、`--auto-approve/--yolo`。ACP 走独立的 `vibe-acp` 二进制。需要 Mistral API key（有免费额度**未核实**）。Apache-2.0。
  来源：https://docs.mistral.ai/vibe/code/cli/work-with-cli 、https://github.com/mistralai/mistral-vibe
- **Grok Build**：`curl -fsSL https://x.ai/cli/install.sh | bash`，或 npm `@xai-official/grok`。`-p`、`--output-format streaming-json`、`-s/-r/-c`、`--always-approve`、`--no-auto-update`。ACP：`grok agent stdio`。认证用 `XAI_API_KEY` 或 `grok login`；是否需要 SuperGrok 订阅说法不一，**未核实**。Apache-2.0。国内需要代理。
  来源：https://docs.x.ai/build/cli/headless-scripting 、https://github.com/xai-org/grok-build
- **Letta Code**：`letta -p ... --output-format stream-json`，第一条是 init 事件（含 agent_id / conversation_id / session_id / model / tools）。`--input-format stream-json` 是双向模式，权限请求以 `control_request`（subtype 为 `can_use_tool`）发出，跟 Claude 的 SDK 协议几乎一样。有状态 agent，记忆持久。BYOK 或 Letta Cloud。Apache-2.0。
  来源：https://docs.letta.com/letta-code/headless/index.md
- **Continue `cn`**：`cn -p ... --format json`、`cn --resume`、`cn ls --json`、`FORCE_NO_TTY`。最近一次发版在 2026-06，活跃度在下降。Apache-2.0。来源：https://github.com/continuedev/continue （extensions/cli）
- **Kilo**：`kilo run --auto`；不加 `--auto` 时权限请求一律拒绝并退出 1。`--format json`；`kilo -c`（不能和 `--auto` 一起用）；`kilo acp`。MIT。来源：https://kilo.ai/docs/cli
- **Warp Oz**：`oz agent run --prompt`，用 `WARP_API_KEY` 认证，按 credit 计费；文档称它是“legacy”接口，建议改用 Warp Factories。输出格式**未核实**。来源：https://docs.warp.dev/agents/cli/oz-cli.md
- **Rovo Dev**：`acli rovodev run "<instr>" [--yolo]`，需要 Atlassian 订阅。来源：https://support.atlassian.com/rovo/docs/rovo-dev-cli-commands

### 国产

- **CodeBuddy Code**：npm `@tencent-ai/codebuddy-code`。flag 基本照抄 Claude Code：`-p`、`--output-format stream-json`、`--input-format stream-json`、`--include-partial-messages`、`--continue`、`--resume <id>`、`--allowedTools`、`--permission-mode acceptEdits`、`--dangerously-skip-permissions`；**不支持** `--permission-prompt-tool`。ACP：`--acp`。需要腾讯云 / CodeBuddy 账号（国内版 copilot.tencent.com 和国际版 codebuddy.ai 是两套账号，**未核实**细节）。闭源（license 写的是 “SEE LICENSE IN README”）。
  来源：https://www.workbuddy.ai/docs/cli/headless 、https://www.workbuddy.ai/docs/cli/cli-reference 、ACP Registry `codebuddy-code/agent.json`
- **Kimi Code CLI**：安装 `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`（单个二进制，不依赖 Node），或 npm `@moonshot-ai/kimi-code`。`-p` 配 `--output-format stream-json`，每行是一个 Assistant / Tool 消息，**思考内容不进 JSONL**；进度和 “resuming session” 提示写到 stderr。print 模式不弹审批（自动策略，但静态 deny 规则仍生效），且 `-p` 不能和 `--yolo`/`--auto`/`--plan` 一起用（**未核实**，来自第三方）。ACP：`kimi acp`。可以 Kimi Code OAuth 登录，也可以用 Moonshot 开放平台 API key。MIT。
  来源：https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command 、https://github.com/MoonshotAI/kimi-code
- **Qoder CLI**：`qodercli -p`（部分文档写的是 `qoder -p`，名字不一致）、`--output-format json|stream-json`、`--input-format stream-json`；headless 下没预先放行的权限会**自动拒绝**。ACP：`--acp`。iFlow 停服后官方引导用户迁到这里。
  来源：https://docs.qoder.com/cli/run-in-scripts 、https://docs.qoder.com/cli/cli-reference
- **MiniMax Code（`mcode`）**：安装 `curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash`，或 npm `@minimax-ai/code`。`mcode exec [prompt]`、`--mode lightweight|standard`、`--continue`、`--session`；`mcode acp`。可以用 Token Plan 账号，也可以 BYOK（`mcode provider add`）。MIT。exec 的输出格式**未核实**。
  来源：https://github.com/MiniMax-AI/minimax-code
- **ZCode**：智谱 2026-09 开源的“编程工作台”，包含桌面端、Web 端和 CLI/TUI。自动化文档给的示例：`zcode --prompt ... --cwd ... --mode ... --disallowed-tools ... --output-format stream-json --no-color`，恢复会话要显式用 `--resume`，并发时**不要**用 `--continue`。Apache-2.0。目前 CLI 主要靠从源码构建（`pnpm --filter @zcode/cli... build`）。
  来源：https://github.com/zai-org/zcode 、`apps/zcode-cli/docs/usage/13-automation.md`
- **Trae Agent**：`pip` 安装，`trae-cli run "<task>" --trajectory-file`，BYOK（支持 `DOUBAO_API_KEY`），MIT。偏研究性质，没有会话恢复，不适合做对话桥。来源：https://github.com/bytedance/trae-agent

---

## 3. 集成方案建议

### 3.1 一等公民（写专用适配器，或者把现有适配器升级）
1. **Antigravity `agy`**（T1）：Gemini 个人用户的继任者，国际用户刚需；stream-json 格式稳定、文档清楚。
2. **CodeBuddy Code**（T1）：国产 CLI 下载量第一，flag 和 Claude 同构，**可以直接复用 `claude.ts` 的 stream-json 解析**，只改命令名和少数 flag。
3. **Kimi → Kimi Code 升级**：把 `--output-format text` 换成 `stream-json`，拿到工具调用中间消息。
4. **pi**（T1，RPC 模式）：周下载近 300 万，也是 Kimchi 等多个 agent 的底座；RPC 模式长驻，适合微信这种多轮对话。
5. **通用 ACP 适配器**（T0）：一次实现，配置即用，见 3.2。

### 3.2 通用 ACP 适配器（T0）设计要点
- 传输：起子进程，通过 stdio 走 JSON-RPC 2.0，**按 LF 分帧**。**每个微信会话对应一个长驻进程**，空闲超时后回收（和现在 `close()` 回收资源的生命周期一致）。
- 流程：`initialize`（声明 `clientCapabilities`：`fs.readTextFile/writeTextFile` 先设 **false**，让 agent 用自带工具；`terminal` 设 false）→ 如果有 `authMethods` 就 `authenticate`（headless 下优先用环境变量里的 key）→ `session/new {cwd, mcpServers: []}`，或者在 agent 声明了 `loadSession` 能力时用 `session/load {sessionId}` 恢复会话 → `session/prompt`。
- 事件映射到 `IntermediateMessage`：`session/update` 里的 `agent_message_chunk` → text；`agent_thought_chunk` → thinking；`tool_call` / `tool_call_update` → tool_use / tool_result；`plan` → 作为 text 摘要。`session/prompt` 的返回值带 `stopReason`，表示一轮结束。
- 权限：收到 `session/request_permission` 时，`mode=auto` 就自动选 `allow_always` / `allow_once`；`mode=safe` 就转给 `askUser` 发到微信让用户选；`mode=plan` 就拒绝。如果 agent 提供了 `session/set_mode`，就把我们的 `ToolMode` 映射过去（大多数 agent 有 `default` / `acceptEdits` / `plan` / `bypass` 这类模式 ID）。
- 中止：`session/cancel`。
- 选型数据源：直接用官方 Registry 里的 `agent.json`（`distribution.npx|uvx|binary` + `args` + `env`），可以做到 `/tool add devin` 自动生成配置。**注意 Registry 里的版本是锁死的**（比如 `cline@3.0.73`），建议允许用户覆盖成本机已安装的命令。
- 已知注意事项：Codex / Claude / pi / Amp 的 ACP 是第三方或官方另做的**适配器包**，不是 CLI 本体，功能可能落后于本体，所以这几个保留原生适配器；Antigravity 的 ACP server 和 CLI 是两个不同的二进制。

### 3.3 配置驱动的通用 JSONL 适配器（T1）
用于有 stream-json 但没 ACP、或者 ACP 不稳的 CLI（Letta、ZCode、Grok、Vibe、Goose、Junie、OpenHands、Cline……）。每个 CLI 只要一份解析规则：按某个字段区分事件类型，再用 JSONPath 指出文本、工具名、会话 ID、结束事件等字段在哪。

### 3.4 用户可配置的“自定义 CLI”条目（建议加到 config）
```jsonc
// ~/.cli-in-wechat/custom-tools.json
{
  "tools": [
    {
      "name": "devin",                 // 微信里 /tool devin
      "displayName": "Devin CLI",
      "protocol": "acp",               // acp | jsonl | text
      "command": "devin",
      "args": ["acp"],
      "env": { "WINDSURF_API_KEY": "${env:WINDSURF_API_KEY}" },
      "modeMap": { "auto": "dangerous", "safe": "normal", "plan": "plan" }
    },
    {
      "name": "agy",
      "protocol": "jsonl",
      "command": "agy",
      // 占位符：{prompt} {sessionId} {model} {cwd}；[...] 包住的部分在变量为空时整段省略
      "args": ["-p", "{prompt}", "--output-format", "stream-json",
               "[--conversation {sessionId}]", "[--model {model}]"],
      "modeArgs": { "auto": ["--dangerously-skip-permissions"], "plan": ["--mode", "plan"] },
      "promptVia": "argv",             // argv | stdin（长 prompt / Windows 下建议用 stdin）
      "parser": {
        "typeField": "type",
        "text":      { "match": { "type": "step_update", "step_type": "text" }, "path": "$.text" },
        "toolUse":   { "match": { "step_type": "tool_call" }, "name": "$.tool.name", "content": "$.tool.input" },
        "sessionId": "$.conversation_id",
        "final":     { "match": { "type": "result" }, "text": "$.result", "error": "$.is_error" }
      },
      "sessionErrorPattern": "conversation .* not found"   // 命中时设 sessionExpired=true
    },
    {
      "name": "rovo",
      "protocol": "text",
      "command": "acli",
      "args": ["rovodev", "run", "{prompt}", "--yolo"],
      "stripAnsi": true,
      "timeoutSec": 3600
    }
  ]
}
```
- 内置一些**预设**（`preset: "claude-like"` 用于 CodeBuddy / Qoder / Letta / Kimi Code 这类 Claude 方言；`preset: "acp-registry:<id>"` 直接从 Registry 拉配置），用户只需要写 `name + preset`。
- `capabilities` 按 protocol 推断：acp 和 jsonl 默认 `streaming/jsonOutput/sessionResume = true`；text 默认只有 `streaming = false`。
- 所有用户输入一律走 `spawnCli`（argv 原样传递），**不要拼 shell 字符串**；`{prompt}` 只允许作为一个完整的 argv 元素。

### 3.5 优先级建议
| 优先级 | 内容 |
|---|---|
| P0 | 通用 ACP 适配器 + 自定义 CLI 配置；Antigravity 适配器；Kimi 适配器升级到 stream-json；Gemini 适配器在认证失败时提示“个人账号已停服，请改用 agy” |
| P1 | CodeBuddy（复用 Claude 解析）；pi RPC；通用 JSONL 适配器 + 预设（Letta / Qoder / Grok / Vibe / Goose / ZCode） |
| P2 | 用 ACP 预设覆盖 Devin、Droid、Junie、Kiro、Cline、Auggie、OpenHands、Kilo、MiniMax、Copilot、Cursor 等，只写文档、不写代码 |
| 不做 | iFlow（停服）、Roo、Plandex、Amazon Q（已改名为 Kiro）、Jules、Comate / Lingma / TRAE IDE（没有 CLI）、Warp Oz（legacy） |

---

## 4. 主要来源
- ACP Registry 仓库：https://github.com/agentclientprotocol/registry （从各 `*/agent.json` 抓取了启动命令、版本和许可证）
- ACP agents 列表：https://agentclientprotocol.com/overview/agents
- Zed ACP Registry 公告：https://zed.dev/blog/acp-registry ；JetBrains：https://blog.jetbrains.com/ai/2026/01/acp-agent-registry/
- Gemini → Antigravity：https://mem.nowledge.co/integrations/antigravity-cli 、https://amplifying.ai/coding-agents/gemini-cli 、https://medium.com/@hsinghungwang/migrating-from-gemini-cli-to-antigravity-cli-agy-af324c10c781 （都是二手，**未核实 Google 原文**）
- iFlow 停服：https://github.com/router-for-me/CLIProxyAPI/issues/2561 （**未核实原文**）
- 其余见第 2 节各条目后面的链接
- 数据：`gh api repos/...`（star 数 / 归档状态 / release）、`api.npmjs.org/downloads/point/last-week/*`、`pypistats.org`，均为 2026-10-23 拉取
