# Changelog

## 0.2.0 — 2026-10-23

大版本更新，原则是精简、好用、轻量：每个 CLI 只保留一条执行路径，依赖更少，命令更少。含破坏性变更，升级说明见 README「从 0.1.x 升级」。

### Added

- 通用 ACP 适配器（自写 JSON-RPC over stdio，无新依赖）和 8 个内置预设：Qwen Code、GitHub Copilot CLI、Cursor CLI、CodeBuddy Code、Factory Droid、Devin CLI、Qoder CLI、MiniMax Code（#41）
- `config.json` 的 `agents`：不写代码接入任意 CLI，支持 `protocol: "acp"` 和 `protocol: "text"`，可覆盖或关闭内置预设（#42）
- 微信内工具审批：`/mode safe` 下回 `1` 允许一次 / `2` 本会话自动允许同类操作（命令按程序名，仅存内存）/ `3` 拒绝，送达后 5 分钟无回复自动拒绝；等待时非选项回复不会被吞掉，`@<其他工具>` 照常执行；审批和 AskUser 提问共用一个按顺序处理的队列（#43）
- `/use [名字]`：按注册表切换任意工具或列出已安装工具；`@<任意工具名>` 单次指定（#44）
- `/set [键] [值]`：收纳各 CLI 专属开关，`/set` 列出当前工具的键，`/set all` 列出全部（#45）
- Codex：流式输出、`/effort`、原生图片输入（`--image`）（#36）
- Claude：原生图片输入、子代理消息过滤、`ExecResult.usage`（#40）
- Gemini：stream-json 流式输出、桥接选定会话 ID（`--session-id`）、`/mode` 映射（#38）
- Kimi：stream-json 流式输出（#37）
- OpenCode：响应 `permission.asked`（1.19+）和 `question.asked`，包括子代理会话（#39）

### Changed

- **Claude 去掉 `@anthropic-ai/claude-agent-sdk`**，直接以双向 stream-json 驱动本机 `claude` CLI；同时去掉 `zod`，`node_modules` 从约 119 MB 降到约 39 MB（#40）
- **`/mode safe` 真正生效**：Claude / OpenCode / ACP 工具在微信里逐次审批，`plan` 只读；`auto` 仍跳过所有确认（#40、#39、#41、#43）
- Codex 改用 `exec --json`，按真实 thread id 续接会话，续接时保留所有选项；`plan` 改为只读沙箱（#36）
- Kimi 用真实会话 ID（`-S <id>`）续接，不再用 `--continue`（#37）
- Gemini 默认跟随 `/mode`；认证报错提示个人账号已于 2026-06-18 停服（#38）
- `/help` 按当前工具能力生成（约 30 行），`/status` 只显示当前工具相关的项；`/mode` 回复说明当前工具的具体行为（#45）
- 旧版 `last` / `continue` 会话标记失效时自动开新会话，并提示一次（#45）
- 切换到未安装的工具会被拒绝，`@未安装工具` 不再悄悄发给默认工具（#44）
- 旧命令（`/turns` `/budget` `/sandbox` `/approval` `/msgmode` 等）在 0.2.0 内仍可用，并提示改用 `/set`（#45）

### Fixed

- Claude：safe/plan 实际等同于 bypass；SDK 报错后整个任务重跑一次（#40）
- Codex：`exec resume --last` 在多人共用 workDir 时串会话；续接时丢失沙箱、模型、搜索等设置；`/search` 的配置键写错（#36）
- Gemini：未信任的工作目录里 yolo 被静默降级，写操作全部失败；多段回答只保留最后一段（#38）
- Kimi：`--continue` 串会话、并发时遇会话锁（退出码 4）失败；stdout 为空时把 stderr 当成回答（#37）
- OpenCode：1.19+ 的权限请求和提问无人应答，任务卡到 1 小时超时；连到 2.x 服务端时静默超时，现在直接报错（#39）
- `/cancel` 和退出时未决的 AskUser 提问不会被结束（#43）

### Removed

- 依赖 `@anthropic-ai/claude-agent-sdk`、`zod`（#40）
- `/verbose`、`/thinking`（已无工具读取）；`/yolo` `/fast` `/plan` `/fork` `/branch` `/continue` `/session` `/init` `/files` 只剩迁移提示（#45）
- Claude 的 SDK → CLI 降级重跑路径（#40）
