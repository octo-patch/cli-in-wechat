# cli-in-wechat

在微信中运行主流 AI 编程 CLI 工具 —— 通过微信 ClawBot 官方 iLink Bot API 实现。

**原生支持：** Claude Code / Codex CLI / Gemini CLI / Kimi Code / OpenCode
**ACP 预设：** Qwen Code / Copilot CLI / Cursor CLI / CodeBuddy / Droid / Devin / Qoder / MiniMax Code
**以及任意 CLI：** 在 `config.json` 里写几行即可接入，不用写代码

## 它是什么

一个运行在你电脑上的桥接服务。微信是遥控器，电脑是执行端。

```
微信 ClawBot (手机)
    ↕  iLink Bot API — 微信官方消息通道 (不封号)
桥接服务 (你的电脑)
    ↕  spawn 本机已安装的 CLI（stream-json / exec --json / ACP / 纯文本）
claude / codex / gemini / kimi / opencode / qwen / copilot / … / 你自己的 CLI
```

- **一个微信驱动多家 CLI**：`/use` 切换，`@工具` 单次指定，`>>` 接力，`@a>b` 链式调用
- **微信内审批**：`/mode safe` 下敏感操作发到微信，回 `1/2/3` 决定
- **会话续接**：每个用户、每个工具各自保存真实会话 ID，不会串会话
- **轻量**：运行时依赖只有 2 个（代理用的 `undici` 可选），不打包任何 CLI 本体

## 支持的工具

| 工具 | `/use` 名字 | 快捷 | 接入方式 | 会话续接 | `/mode` | 微信审批 |
|---|---|---|---|---|---|---|
| Claude Code | `claude` | `/cc` | `claude -p` 双向 stream-json | ✓ | auto / safe / plan | ✓ |
| Codex CLI | `codex` | `/cx` | `codex exec --json` | ✓ | auto / safe / plan | — ¹ |
| Gemini CLI | `gemini` | `/gm` | `gemini -p` stream-json | ✓ | auto / safe / plan | — ² |
| Kimi Code | `kimi` | `/km` | `kimi -p` stream-json | ✓ | 仅 auto ³ | — |
| OpenCode | `opencode` | `/oc` | `opencode serve`（SDK），失败时降级 `opencode run` | ✓ | auto / safe / plan | ✓ |
| Qwen Code | `qwen` | | ACP（`qwen --acp`） | ✓ | auto / safe / plan | ✓ |
| GitHub Copilot CLI | `copilot` | | ACP（`copilot --acp --stdio`） | ✓ ⁴ | auto / safe / plan | ✓ |
| Cursor CLI | `cursor` | | ACP（`cursor-agent acp`） | ✓ ⁴ | auto / safe / plan | ✓ |
| CodeBuddy Code | `codebuddy` | | ACP（`codebuddy --acp`） | ✓ ⁴ | auto / safe / plan | ✓ |
| Factory Droid | `droid` | | ACP（`droid exec --output-format acp`） | ✓ ⁴ | auto / safe / plan | ✓ |
| Devin CLI | `devin` | | ACP（`devin acp`） | ✓ ⁴ | auto / safe / plan | ✓ |
| Qoder CLI | `qoder` | | ACP（`qodercli --acp`） | ✓ ⁴ | auto / safe / plan | ✓ |
| MiniMax Code | `minimax` | | ACP（`mcode acp`） | ✓ ⁴ | auto / safe / plan | ✓ |
| 自定义（`protocol: "acp"`） | 自己起 | | ACP | ✓ ⁴ | auto / safe / plan | ✓ |
| 自定义（`protocol: "text"`） | 自己起 | | stdin / 参数 → stdout | — | 仅 auto | — |

1. Codex `exec` 没有审批通道：safe 在 `workspace-write` 沙箱内自动执行，不会问你。
2. Gemini safe 对应 `--approval-mode default`，非交互模式下需要确认的操作会被直接拒绝（回复里会提示改用 `/mode auto`）。
3. Kimi `-p` 模式恒为 auto，`/mode` 对它无效。
4. 需要该 CLI 声明支持 `session/load`，否则每条消息都是新会话。

启动时会自动检测本机装了哪些工具，`/use` 只列出已安装的。

## 安装

### 前置要求

- **Node.js** >= 20
- **微信** 已启用 ClawBot 插件（我 → 设置 → 插件）
- 至少一个 CLI 工具，并且**先在终端里登录一次**：

```bash
npm install -g @anthropic-ai/claude-code   # Claude Code → 运行 claude 登录
npm install -g @openai/codex                # Codex CLI   → 运行 codex 登录
npm install -g @google/gemini-cli           # Gemini CLI  → 设置 GEMINI_API_KEY
npm install -g @moonshot-ai/kimi-code       # Kimi Code   → kimi login（或 curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash）
npm install -g opencode-ai@1                # OpenCode 1.x → 设置 ANTHROPIC_API_KEY / OPENAI_API_KEY 等
```

ACP 预设里的工具按各自官方文档安装、登录即可，桥接不会替你登录。

> - **Claude Code 不再需要 Agent SDK**：桥接直接驱动本机的 `claude` 命令，`npm install` 后的 `node_modules` 约 39 MB（0.1.x 约 119 MB）。
> - **Gemini 个人 Google 账号自 2026-06-18 起停止服务**：请改用付费的 `GEMINI_API_KEY`、Vertex AI，或换成 Antigravity CLI（`agy`）。
> - **OpenCode 只支持 1.x**：Homebrew / `@opencode/cli` 装的是 2.x，桥接会直接报错并提示安装 `opencode-ai@1`。

### 运行

```bash
git clone https://github.com/sgaofen/cli-in-wechat.git
cd cli-in-wechat
npm install
npm run dev           # 开发模式
npm run dev:debug     # 调试模式
```

首次运行显示 QR 码，用微信扫码登录 ClawBot。

## 使用方法

### 发消息与切换工具

| 输入 | 行为 |
|---|---|
| 直接打字 | 发给当前工具 |
| `/use` | 列出本机可用的工具 |
| `/use qwen`、`/cc` | 切换当前工具 |
| `@codex fix the bug` | 指定工具，之后的消息也发给它 |
| `@claude>codex 先分析再修复` | 链式调用 |
| `>> 根据上面的分析修复` | 把上条结果作为上下文接力 |

回复微信里的某条消息，会由发出那条消息的工具接手。

### 权限模式 `/mode`

| 模式 | 含义 |
|---|---|
| `auto`（默认） | 最高权限，跳过所有确认（Claude 为 `--dangerously-skip-permissions`） |
| `safe` | 每次敏感操作在微信里问你，回 `1` 允许一次 / `2` 本会话自动允许同类操作 / `3` 拒绝；审批消息送达后 5 分钟无回复自动拒绝 |
| `plan` | 只读，只规划不改动 |

```
Claude 请求权限：Run `npm test`
1. 允许一次
2. 本会话自动允许所有「npm 命令」
3. 拒绝
— 回复数字；5 分钟无回复自动拒绝
```

- 「2」的范围：命令类按程序名（允许过 `npm test` 就放行 `npm run build`，但不会放行 `rm -rf`）；其他操作按工具上报的类型；提示里会写明范围。
- 「2」只记在桥接进程的内存里，不会写进工具自己的配置；`/new`、`/clear`、`/compact`、`/reset`、`/dir`、`/resume` 或重启后失效。
- 等待审批时：只有列出的数字才算回答（填错会再问一次，再错就拒绝）；普通文字不会被当成回答，会提示「这条消息未执行，处理完后请重发」；`@<其他工具> …` 照常执行。
- 提问或审批还没送达微信时（比如本轮配额已用完），任何消息都不算回答，回复「继续」先把它收下来。
- 工具主动提问（如 Claude 的 AskUserQuestion、OpenCode 的 question）也走同一个队列，回编号或直接回文字都行。
- 各工具在三种模式下的具体表现见上面的支持矩阵；`/mode <模式>` 的回复也会说明当前工具怎么执行。

### 命令速查

`/help` 会按当前工具的能力自动生成，只显示它支持的命令。

| 命令 | 作用 |
|---|---|
| `/use [名字]` | 切换工具 / 列出可用工具；`/cc` `/cx` `/gm` `/km` `/oc` 为快捷方式 |
| `/status` | 当前工具、模式、模型、会话和改过的设置 |
| `/model <名\|default>`、`/models` | 切模型；`/models` 查看可用模型（OpenCode） |
| `/mode <auto\|safe\|plan>` | 权限模式 |
| `/effort <low\|med\|high\|xhigh\|max>` | 思考深度（支持的工具） |
| `/dir <路径>` | 工作目录 |
| `/set [键] [值]` | 其他设置；`/set` 列出当前工具的键，`/set all` 列出全部 |
| `/reset` | 重置所有设置 |
| `/new` | 新会话（`/clear` 额外清掉 `>>` 接力内容） |
| `/resume [编号\|id]` | 浏览历史会话 / 恢复指定会话 |
| `/cancel` | 取消当前任务 |
| `/tasks [ack]` | 查看 / 确认因重启中断的任务 |
| `/send <路径>` | 把本地文件发到微信 |
| `/diff` `/commit` `/review` | 常用 git 操作 |
| `/stats` | 上次回复的统计 |

`/set` 的键：

| 键 | 作用 | 生效工具 |
|---|---|---|
| `msgmode verbose\|normal\|compact` | 消息详细度 | 全部 |
| `thoughts [on\|off]` | 显示 AI 思考内容 | 全部 |
| `system <文本\|off>` | 追加系统提示 | Claude |
| `turns <数>`、`budget <$\|off>` | 最大轮次、预算 | Claude |
| `tools <列表\|off>`、`notool <列表>` | 允许 / 禁用的工具 | Claude |
| `bare [on\|off]`、`name <名>` | 跳过配置加载、会话命名 | Claude |
| `adddir <路径>` | 额外目录 | Claude / Codex / Kimi |
| `sandbox read-only\|write\|full\|off` | 沙箱（覆盖 `/mode`） | Codex / Gemini |
| `search`、`ephemeral`、`profile <名>` | web 搜索、临时会话、config profile | Codex |
| `approval default\|auto_edit\|yolo\|plan\|off` | 审批模式（覆盖 `/mode`，`off` 恢复跟随） | Gemini |
| `include <目录>`、`ext <名>` | 额外上下文目录、扩展 | Gemini |

布尔键不带值时切换开关。

## 配置

`~/.wx-ai-bridge/config.json`：

```jsonc
{
  "defaultTool": "claude",
  "workDir": "/Users/you",
  "cliTimeout": 300000,
  "allowedUsers": [],        // 留空时仅允许当前扫码登录用户
  "allowAllUsers": false,    // 仅在明确需要公开访问时设为 true
  "tools": {
    "claude": { "args": ["--max-turns", "50"] }   // 追加到该工具命令行的参数
  }
}
```

> **安全：默认只允许当前扫码登录用户。** 如需增加管理员，请填写 `allowedUsers`；
> 只有显式设置 `allowAllUsers: true` 才会允许任意好友以完整权限运行 CLI。

### 自定义 Agent（无需写代码）

在 `config.json` 里加 `agents` 即可接入任意 CLI，改完重启生效：

```jsonc
{
  "agents": [
    // 支持 ACP 的 CLI：流式、会话恢复、/mode 和微信审批都可用
    { "name": "my-acp", "displayName": "My Agent", "command": "my-agent", "args": ["acp"], "protocol": "acp",
      "modeIds": { "auto": "yolo", "safe": "default", "plan": "plan" } },
    // 纯文本 CLI：prompt 走 stdin（默认），返回 stdout；无会话恢复，/mode 恒为 auto
    { "name": "llm", "command": "llm", "args": ["-m", "gpt-4o"], "protocol": "text" },
    // prompt 作为参数：args 里的 {prompt} 会被替换（没有占位符则追加到末尾）
    { "name": "aider", "command": "aider", "args": ["--yes", "--message", "{prompt}"], "protocol": "text", "promptVia": "arg" },
    // 同名覆盖内置 ACP 预设的字段 / 关闭某个预设
    { "name": "cursor", "command": "agent" },
    { "name": "devin", "disabled": true }
  ]
}
```

- `protocol` 默认 `acp`；`modeIds` 把 `/mode` 映射到该 agent 自己的 ACP 模式 ID，不写就只靠权限请求来区分模式。
- `name` 只能用小写字母、数字和 `-`，不能与 claude/codex/gemini/kimi/opencode 重名；`env` 可追加环境变量。
- 写错的条目只会在启动日志里警告并跳过，不影响其他工具。
- 覆盖预设时如果改了 `protocol`，就不再继承预设的 `args` / `modeIds`。
- Windows 下 `promptVia: "arg"` 要求命令能直接定位到 .exe/.js（不经过 cmd.exe），否则为防注入会拒绝执行，请改用 stdin。
- 之后用 `/use my-acp` 或 `@my-acp 你好` 调用。

## 从 0.1.x 升级

数据不用迁移：`sessions.json` 等文件原样保留。主要是命令有变化，旧写法在 0.2.0 里**仍然能用**，会顺带提示新写法，后续版本会移除。

| 0.1.x | 0.2.0 |
|---|---|
| `/turns` `/budget` `/tools` `/notool` `/bare` `/name` `/system` | `/set turns …` 等，见上表 |
| `/adddir` `/sandbox` `/search` `/ephemeral` `/profile` | `/set adddir …` 等 |
| `/approval` `/include` `/ext` | `/set approval …` 等 |
| `/msgmode` `/thoughts` | `/set msgmode …`、`/set thoughts` |
| `/yolo` | `/mode auto` + `/effort max` |
| `/fast` | `/effort low` |
| `/plan [描述]` | `/mode plan` |
| `/fork`、`/branch` | `/new` |
| `/continue`、`/session [set <id>]` | `/resume [<id>]` |
| `/compact`、`/compress`、`/summarize` | `/new`（仍可用） |
| `/init`、`/files` | 直接让工具去做 |
| `/verbose`、`/thinking` | 已删除（没有工具在用） |
| `@claude` 等固定写法 | `@<任意工具名>`，`/use` 统一切换 |

其他需要知道的变化：

- **`/mode safe` 现在真的会问你**。0.1.x 里 Claude 的 safe/plan 实际等同于 bypass；现在 safe 走微信审批，plan 不能改文件。只想要以前的行为就用默认的 `/mode auto`。
- **Codex / Kimi 旧会话会自动开新会话**。0.1.x 保存的是 `last` / `continue` 这样的占位标记（多人共用目录时会串会话），升级后第一条消息会开新会话并回复一次「[旧版会话标记已失效，已开新会话]」，之后就用真实会话 ID。
- **切到没装的工具会被拒绝**，`@没装的工具 …` 也不会再悄悄发给默认工具。
- **Gemini** 改为跟随 `/mode`（以前不设 `/approval` 时恒为 yolo），并自动信任工作目录；个人 Google 账号已停服，见安装一节。
- **Claude 的依赖变少**：不再安装 `@anthropic-ai/claude-agent-sdk`，只要本机 `claude` 命令可用。

完整变更见 [CHANGELOG.md](./CHANGELOG.md)。

## 网络与代理（故障排查）

所有对微信接口的请求都带 **超时 + 指数退避抖动重试 + 可读诊断**，瞬时网络抖动
（如 `read ECONNRESET`、`fetch failed`）会被自动重试吞掉（[issue #18](https://github.com/sgaofen/cli-in-wechat/issues/18)）。

- **代理**：Node 的全局 `fetch` 默认不读代理环境变量。若你需要走代理访问微信，
  设置 `HTTPS_PROXY`（或 `HTTP_PROXY` / `ALL_PROXY`）并安装可选依赖 `undici`：

  ```bash
  npm i undici                 # 启用代理支持（可选依赖）
  export HTTPS_PROXY=http://127.0.0.1:7890
  npm run dev
  ```

- **仍然 `ECONNRESET` / `fetch failed`**：确认本机可访问 `ilinkai.weixin.qq.com`；
  尝试关闭/更换代理或 VPN；用 `npm run dev:debug` 查看带诊断的日志。
- **会话过期自动重登**：token 失效（errcode -14/-13）时会自动重新出示 QR 码重登，
  而不是直接退出。
- **重启后的任务**：桥接重启时正在跑的任务会标记为中断，用 `/tasks` 查看，`/tasks ack` 确认。

## 架构

```
src/
├── index.ts / config.ts   # 入口、配置
├── ilink/                 # 微信 iLink Bot API：扫码登录、长轮询、配额感知的发件箱
├── bridge/                # 路由（/ 命令、@ 路由、>> 接力、微信审批）、会话、任务持久化
├── adapters/              # 每个 CLI 一条执行路径
│   ├── claude.ts          # claude -p 双向 stream-json + stdio 控制协议
│   ├── codex.ts           # codex exec --json
│   ├── gemini.ts / kimi.ts# stream-json
│   ├── opencode*.ts       # opencode serve (SDK)，降级 opencode run
│   ├── acp/               # 通用 ACP 客户端 + 8 个预设
│   ├── text.ts            # 自定义纯文本 CLI
│   └── registry.ts        # 注册、合并 config agents、检测已安装工具
├── cli/send.ts            # wcli send：发送本地文件到微信
└── utils/                 # http（超时/重试/代理）、媒体解密、日志
```

## 微信 iLink Bot API

微信 2026 年 3 月推出的 ClawBot 插件官方 API：

- 域名：`ilinkai.weixin.qq.com`（腾讯官方）
- 认证：QR 扫码 → Bearer token
- 收消息：HTTP 长轮询 (35s)
- 发消息：POST + context_token
- **官方通道，不封号**

## License

MIT
