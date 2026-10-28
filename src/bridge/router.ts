import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { ordinaryOpenCodeModels } from '../adapters/opencode-models.js';
import { log } from '../utils/logger.js';
import { ILinkClient, isDeliveryFinalizationError } from '../ilink/client.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { SessionManager } from './session.js';
import { formatResponse } from './formatter.js';
import type { WeixinMessage } from '../ilink/types.js';
import type { BridgeConfig } from '../config.js';
import {
  DEFAULT_SETTINGS,
  type AdapterCapabilities,
  type AskUserRequest,
  type MsgMode,
  type PermissionRequest,
  type UserSettings,
} from '../adapters/base.js';
import type { DownloadedMedia } from '../utils/media.js';
import type { OutboxItem } from '../ilink/outbox.js';
import {
  InboundTaskStore,
  type DeliveryOutcome,
  type ExecDeliveryOutcome,
  type InboundTask,
  type RecoveryReason,
  type TaskFileStep,
  type TaskOutput,
} from './task-store.js';

interface ActiveTask { abort: AbortController; tool: string }

/** The durable task an Agent run belongs to. Direct calls (tests, legacy paths) get an ephemeral one. */
interface TaskRun { taskId: string; store: InboundTaskStore; generation?: number }

export interface RouterOptions {
  /** Durable inbound task ledger. Defaults to memory-only (no restart recovery). */
  taskStore?: InboundTaskStore;
  /** Identity of this process' runners; a task owned by any other boot was interrupted. */
  bootId?: string;
}

type DeliveryStatusView = { quota: { generation: number }; pending: Array<Pick<OutboxItem, 'itemId'>>; failed?: Array<Pick<OutboxItem, 'itemId'>> };

/** Why a pending interaction ended without a usable answer. */
type InteractionEnd = 'timeout' | 'cancelled' | 'invalid' | 'stopped' | 'unsent';

/**
 * One prompt waiting for the user's WeChat reply: an AskUser question or a tool approval.
 * Interactions are queued per user and shown one at a time, so a bare "1" is never ambiguous.
 * They live in memory only: the CLI process that asked dies with the bridge, so after a
 * restart there is nobody left to deliver an answer to (see `staleAnswerHint`).
 */
interface PendingInteraction {
  /** Tool whose run is waiting: an @mention of any other tool is never taken as the answer. */
  toolName: string;
  /** What the user is expected to send, for the "message not executed" notice. */
  waitingHint: string;
  /** Approvals only accept a listed choice; AskUser questions take any text. */
  freeText: boolean;
  /** The prompt actually reached WeChat (not merely queued in the outbox). */
  delivered: boolean;
  text: string;
  /** Sent once after an invalid reply; absent when every reply is a valid answer. */
  retryText?: string;
  retried: boolean;
  done: boolean;
  /** Try to settle with this reply; false when the reply is not a valid answer. */
  answer: (reply: string) => boolean;
  /** Settle without asking when the answer is already known (a session grant); true if settled. */
  preempt: () => boolean;
  expire: (why: InteractionEnd) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Reply window, counted from when the prompt actually reached WeChat. */
const INTERACTION_TIMEOUT_MS = 300_000;
/** How often a prompt still queued in the outbox is checked for delivery. */
const PROMPT_DELIVERY_POLL_MS = 5_000;
/** A reply that only makes sense as an answer to a numbered prompt: "2", "1,3". */
const BARE_ANSWER = /^\d{1,2}(?:\s*[,，]\s*\d{1,2})*$/;
/** A late bare answer within this window gets a hint instead of reaching an Agent as a prompt. */
const STALE_ANSWER_WINDOW_MS = 30 * 60_000;

/** Built fresh per call: a shared /g regex carries lastIndex state across calls. */
const sendFileMarkerRegex = (): RegExp => /\[SEND_FILE:\s*([^\]]+)\]/g;

/** Longest partial `[SEND_FILE: …` head we will hold back waiting for its closing `]`.
 *  Bounded so a marker that never terminates cannot buffer a whole response. */
const MAX_MARKER_CARRY = 256;

/**
 * Build a stripper for `[SEND_FILE: …]` markers in text about to be streamed to WeChat.
 *
 * buildOutputs() removes these markers, but only from the FINAL consolidated
 * response. In normal/verbose msgMode the text is also pushed to WeChat as it streams,
 * which bypasses that strip entirely — so the raw marker leaked into the chat. Since the
 * marker is almost always the last thing in a response, nothing arrives to interrupt the
 * 2.5s flush debounce, making the leak reliably reproducible rather than a rare race.
 *
 * Stateful because a marker can straddle two streamed blocks: an unterminated head is
 * held back and rejoined with the next block, so neither half reaches the chat. If the
 * closing `]` never arrives the head is dropped rather than emitted — the marker is a
 * token we inject ourselves, so a run-on `[SEND_FILE:` is a broken marker, not prose.
 *
 * One stripper per request; do not share across users.
 */
export function createSendFileMarkerStripper(): (text: string) => string {
  let carry = '';
  return (text: string): string => {
    const combined = carry + text;
    carry = '';
    let out = combined.replace(sendFileMarkerRegex(), '');
    const head = /\[SEND_FILE:[^\]]*$/.exec(out);
    if (head) {
      out = out.slice(0, head.index);
      if (head[0].length <= MAX_MARKER_CARRY) carry = head[0];
    }
    return out.trim();
  };
}

/** Two-letter shortcuts for the built-in tools (/cc, @cx …). Any other tool goes by its registry name. */
const SHORT_ALIASES: Record<string, string> = {
  cc: 'claude', cx: 'codex', gm: 'gemini', km: 'kimi', oc: 'opencode',
};

/**
 * Per-tool switches behind `/set <key> <value>`. `tools` lists the adapters that read the
 * field (omitted = bridge-side, applies to every tool); `/set` and `/status` show only the
 * keys relevant to the current tool.
 */
interface SettingDef {
  key: string;
  field: keyof UserSettings;
  type: 'bool' | 'int' | 'money' | 'text' | 'enum';
  hint: string;
  tools?: string[];
  /** enum: typed value → stored value ('' = unset). */
  values?: Record<string, string>;
}

const SETTINGS: SettingDef[] = [
  { key: 'msgmode', field: 'msgMode', type: 'enum', hint: 'verbose|normal|compact 消息详细度',
    values: { verbose: 'verbose', detailed: 'verbose', normal: 'normal', compact: 'compact', simple: 'compact', default: DEFAULT_SETTINGS.msgMode } },
  { key: 'thoughts', field: 'showThoughts', type: 'bool', hint: '显示 AI 思考内容' },
  { key: 'system', field: 'systemPrompt', type: 'text', hint: '追加系统提示', tools: ['claude'] },
  { key: 'turns', field: 'maxTurns', type: 'int', hint: '最大轮次', tools: ['claude'] },
  { key: 'budget', field: 'maxBudget', type: 'money', hint: '预算美元 (off=无限)', tools: ['claude'] },
  { key: 'tools', field: 'allowedTools', type: 'text', hint: '允许的工具 (逗号分隔)', tools: ['claude'] },
  { key: 'notool', field: 'disallowedTools', type: 'text', hint: '禁用的工具 (逗号分隔)', tools: ['claude'] },
  { key: 'bare', field: 'bare', type: 'bool', hint: '跳过配置加载', tools: ['claude'] },
  { key: 'name', field: 'sessionName', type: 'text', hint: '会话命名', tools: ['claude'] },
  { key: 'adddir', field: 'addDir', type: 'text', hint: '额外目录', tools: ['claude', 'codex', 'kimi'] },
  // Codex takes the level; Gemini's --sandbox is on/off, so any level turns it on there.
  { key: 'sandbox', field: 'sandbox', type: 'enum', hint: 'read-only|write|full|off 沙箱 (覆盖 /mode；Gemini 只分开/关)', tools: ['codex', 'gemini'],
    values: {
      ro: 'read-only', 'read-only': 'read-only', readonly: 'read-only',
      ws: 'workspace-write', 'workspace-write': 'workspace-write', write: 'workspace-write',
      full: 'danger-full-access', 'danger-full-access': 'danger-full-access', danger: 'danger-full-access',
      off: '', reset: '',
    } },
  { key: 'search', field: 'search', type: 'bool', hint: 'web 搜索', tools: ['codex'] },
  { key: 'ephemeral', field: 'ephemeral', type: 'bool', hint: '临时会话 (不落盘)', tools: ['codex'] },
  { key: 'profile', field: 'profile', type: 'text', hint: 'config profile', tools: ['codex'] },
  { key: 'approval', field: 'approvalMode', type: 'enum', hint: 'default|auto_edit|yolo|plan|off 覆盖 /mode', tools: ['gemini'],
    values: { default: 'default', auto_edit: 'auto_edit', yolo: 'yolo', plan: 'plan', off: '', reset: '' } },
  { key: 'include', field: 'includeDirs', type: 'text', hint: '额外上下文目录', tools: ['gemini'] },
  { key: 'ext', field: 'extensions', type: 'text', hint: '扩展', tools: ['gemini'] },
];

/** 0.2.0 slimming, kept for one release: old command → /set key. The old form still works. */
const MOVED_TO_SET: Record<string, string> = {
  msgmode: 'msgmode', thoughts: 'thoughts', system: 'system', sys: 'system',
  turns: 'turns', t: 'turns', budget: 'budget', b: 'budget', tools: 'tools', notool: 'notool',
  bare: 'bare', name: 'name', adddir: 'adddir', 'add-dir': 'adddir',
  sandbox: 'sandbox', sb: 'sandbox', search: 'search', ephemeral: 'ephemeral', profile: 'profile',
  approval: 'approval', include: 'include', inc: 'include', ext: 'ext', extensions: 'ext',
};

/** 0.2.0 slimming, kept for one release: removed command → what to do instead. */
const REMOVED_COMMANDS: Record<string, string> = {
  verbose: '已移除（Kimi 新版没有 --verbose）', v: '已移除（Kimi 新版没有 --verbose）',
  thinking: '已移除（Kimi 新版没有 --thinking）',
  yolo: '已移除，请用 /mode auto 和 /effort max', fast: '已移除，请用 /effort low',
  plan: '已移除，请用 /mode plan', fork: '已移除，请用 /new', branch: '已移除，请用 /new',
  continue: '已移除，请用 /resume', session: '已移除，请用 /resume（/resume <id> 直接指定会话）',
  init: '已移除，直接把需求发给工具即可', files: '已移除，直接把需求发给工具即可',
};

const MODE_MEANING: Record<string, string> = {
  auto: 'AUTO = 最高权限，不询问',
  safe: 'SAFE = 每次敏感操作在微信里问你\n回 1 允许一次 / 2 本会话自动允许同类（同一程序的命令或同类操作，提示里写明范围） / 3 拒绝，5 分钟无回复自动拒绝',
  plan: 'PLAN = 只读，只规划不改动',
};

/** How each built-in tool realises /mode; other tools (ACP, config agents) map it themselves. */
const MODE_NOTES: Record<string, Record<string, string>> = {
  claude: { auto: 'bypass：跳过全部权限确认', safe: '需确认的工具调用发到微信审批', plan: '--permission-mode plan，不能改文件' },
  codex: {
    auto: '--dangerously-bypass-approvals-and-sandbox（无沙箱）',
    safe: 'workspace-write 沙箱内自动执行（exec 没有审批通道，不会问你）',
    plan: '--sandbox read-only',
  },
  gemini: {
    auto: '--approval-mode yolo', safe: '--approval-mode default（非交互模式下需确认的操作会被拒绝）', plan: '--approval-mode plan',
  },
  kimi: { auto: '-p 模式恒为 auto', safe: '-p 模式恒为 auto，/mode 对 Kimi 无效', plan: '-p 模式恒为 auto，/mode 对 Kimi 无效' },
};

/** Session-id sentinels older adapters stored instead of a real id (codex `--last`, kimi `--continue`). */
const LEGACY_SESSION_SENTINELS: Record<string, string> = { codex: 'last', kimi: 'continue' };

const THOUGHTS_VERBOSE_WARNING = '⚠️ 高频交互任务（如浏览器操作）不建议同时开启 thoughts 和 msgmode verbose，可能触发 iLink 限流，通常约 2-3 分钟恢复。';

const NORMAL_ACTIVITY_MAX_LINES_PER_MESSAGE = 12;
const NORMAL_ACTIVITY_MAX_CHARS_PER_MESSAGE = 1400;
const NORMAL_ACTIVITY_SPLIT_DELAY_MS = 5000;

export class Router {
  private ilink: ILinkClient;
  private registry: AdapterRegistry;
  private sessions: SessionManager;
  private config: BridgeConfig;
  private active = new Map<string, ActiveTask>();
  private lastResponse = new Map<string, { tool: string; text: string }>();
  /** Per-user FIFO of interactions; the head is the one shown to the user. */
  private interactions = new Map<string, PendingInteraction[]>();
  /** When a user's last interaction expired unanswered (timeout / cancel), for late-reply hints. */
  private expiredInteractions = new Map<string, number>();
  /** "本会话自动允许" grants: `${uid}:${tool}` → rule keys (see permissionRule). Memory only. */
  private sessionGrants = new Map<string, Set<string>>();
  /**
   * The list each user last got from `/resume` for a tool (keyed `uid:tool`), with the workDir it
   * was listed for, so `/resume <编号>` never picks from another user's, tool's or directory's list.
   */
  private lastSessionLists = new Map<string, { workDir: string; items: Array<{ id: string; date: string; summary: string }> }>();
  private readonly tasks: InboundTaskStore;
  private readonly bootId: string;
  /** In-process runner registry: at most one background runner per task id. */
  private runners = new Map<string, Promise<void>>();
  /**
   * Outputs the outbox accepted while the ledger could not record it (`taskId#index` → item ids).
   * Consulted before any re-enqueue so an in-process resume never duplicates them; the durable
   * mark is retried on every later touch.
   */
  private enqueuedNotRecorded = new Map<string, string[]>();
  private stopping = false;

  constructor(
    ilink: ILinkClient,
    registry: AdapterRegistry,
    sessions: SessionManager,
    config: BridgeConfig,
    options: RouterOptions = {},
  ) {
    this.ilink = ilink;
    this.registry = registry;
    this.sessions = sessions;
    this.config = config;
    this.tasks = options.taskStore ?? new InboundTaskStore();
    this.bootId = options.bootId ?? randomUUID();
  }

  /**
   * Recover durable tasks left by a previous boot, then accept inbound. Must run
   * before the poll loop starts so restart reconciliation sees a quiet outbox.
   */
  start(): void {
    this.recoverTasks();
    this.ilink.onMessage((msg, text, refText, media) => this.acceptInbound(msg, text, refText, media));
  }

  /** Resolves once every background runner of this process has settled (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.runners.size > 0) {
      await Promise.allSettled([...this.runners.values()]);
    }
  }

  /** Abort every in-flight CLI task and cancel pending questions — called on shutdown so
   *  spawned children get a SIGTERM/taskkill instead of being orphaned. Tasks owned by
   *  this boot keep their durable phase, so the next boot classifies them explicitly. */
  stop(): void {
    this.stopping = true;
    const seen = new Set<AbortController>();
    for (const task of this.active.values()) {
      if (!seen.has(task.abort)) { seen.add(task.abort); task.abort.abort(); }
    }
    this.active.clear();
    // Settle every waiter (approvals reject, questions throw) so no adapter is left hanging.
    for (const queue of [...this.interactions.values()]) {
      for (const pending of [...queue]) pending.expire('stopped');
    }
    this.interactions.clear();
  }

  private resolveToolFromRefText(refText: string): string | undefined {
    // Parse tool from footer: "— DisplayName | ..."
    const footerMatch = refText.match(/— ([^\|\n]+?)(?:\s*\||\s*$)/m);
    if (footerMatch) return this.registry.getNameByDisplayName(footerMatch[1].trim());
    return undefined;
  }

  /**
   * Registry name for what the user typed: a two-letter shortcut, a registered tool name
   * (built-in, ACP preset or config agent — whatever the registry holds) or its display name.
   */
  private resolveToolName(raw: string): string | undefined {
    const typed = raw.trim();
    const lower = typed.toLowerCase();
    if (SHORT_ALIASES[lower]) return SHORT_ALIASES[lower];
    if (this.registry.getAll().some((adapter) => adapter.name === lower)) return lower;
    const byDisplay = this.registry.getAll().find((adapter) => adapter.displayName.toLowerCase() === lower);
    return byDisplay ? this.registry.getNameByDisplayName(byDisplay.displayName) : undefined;
  }

  /** Installed tools in registry order, one entry per tool (an SDK → CLI fallback is not listed twice). */
  private availableTools(): Array<{ name: string; displayName: string; short?: string }> {
    const shortFor = new Map(Object.entries(SHORT_ALIASES).map(([short, name]) => [name, short]));
    const order = this.registry.getAll().map((adapter) => adapter.name);
    const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
    return this.registry.getAvailableNames()
      .map((name) => ({ name, displayName: this.registry.get(name)?.displayName ?? name, short: shortFor.get(name) }))
      .filter((tool) => (this.registry.getNameByDisplayName(tool.displayName) ?? tool.name) === tool.name)
      .sort((a, b) => rank(a.name) - rank(b.name));
  }

  private availableToolList(): string {
    return this.availableTools().map((tool) => tool.name).join(', ') || '无';
  }

  /** Why `@a>b` can't run (unknown or uninstalled tool), or undefined when both are usable. */
  private chainProblem(rawA: string, rawB: string): string | undefined {
    for (const raw of [rawA, rawB]) {
      const name = this.resolveToolName(raw);
      if (!name) return `未知终端: @${raw}，链式调用未执行\n可用: ${this.availableToolList()}`;
      if (!this.registry.isAvailable(name)) return `"${name}" 未安装或不可用，链式调用未执行\n可用: ${this.availableToolList()}`;
    }
    return undefined;
  }

  /** /use, /cc …: switch the default tool when it is installed. */
  private async switchTool(uid: string, raw: string): Promise<void> {
    const name = this.resolveToolName(raw);
    if (!name) {
      await this.ilink.sendText(uid, `未知工具: ${raw}\n可用: ${this.availableToolList()}`);
      return;
    }
    if (!this.registry.isAvailable(name)) {
      await this.ilink.sendText(uid, `"${name}" 未安装或不可用\n可用: ${this.availableToolList()}`);
      return;
    }
    this.sessions.update(uid, { defaultTool: name });
    await this.ilink.sendText(uid, `→ ${name}`);
  }

  // ── getCli: determine terminal from @mention → ref footer → current session ──
  private getCli(uid: string, text: string, refText?: string): string {
    const atMatch = text.match(/^@([\w-]+)/);
    if (atMatch) {
      const resolved = this.resolveToolName(atMatch[1]);
      if (resolved && this.registry.isAvailable(resolved)) return resolved;
    }
    if (refText) {
      const resolved = this.resolveToolFromRefText(refText);
      if (resolved && this.registry.isAvailable(resolved)) return resolved;
    }
    return this.sessions.get(uid).defaultTool || this.config.defaultTool;
  }

  private getDefaultMsgMode(): MsgMode {
    return this.normalizeMsgMode(DEFAULT_SETTINGS.msgMode);
  }

  private normalizeMsgMode(mode?: string): MsgMode {
    const v = (mode || '').toLowerCase();
    if (v === 'verbose' || v === 'normal' || v === 'compact') return v;
    return DEFAULT_SETTINGS.msgMode;
  }

  private normalizeModelArg(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';

    const unquoted = trimmed.replace(/^["'“”]+|["'“”]+$/g, '');
    const lower = unquoted.toLowerCase();
    if (lower === 'default' || lower === 'reset' || unquoted === '默认' || unquoted === '默认模型') {
      return '';
    }

const noTrailingSlash = unquoted.replace(/\/+$/, '');
    const noSlashDotTail = noTrailingSlash.replace(/(?:\/[.。．])+$/u, '');
    const normalized = noSlashDotTail.replace(/[。．.!！?？,，;；、]+$/u, '').trim();
    const finalModel = normalized || noSlashDotTail;
    const finalLower = finalModel.toLowerCase();

    if (!finalModel || finalLower === 'default' || finalLower === 'reset' || finalModel === '默认' || finalModel === '默认模型') {
      return '';
    }

    return finalModel;
  }

  private splitNormalActivityLines(lines: string[]): string[][] {
    if (lines.length === 0) return [];

    const singlePayloadLength = ['Activity', ...lines].join('\n').length;
    if (lines.length <= NORMAL_ACTIVITY_MAX_LINES_PER_MESSAGE && singlePayloadLength <= NORMAL_ACTIVITY_MAX_CHARS_PER_MESSAGE) {
      return [lines.slice()];
    }

    const batches: string[][] = [];
    let current: string[] = [];
    let currentLen = 'Activity'.length;

    const flushCurrent = () => {
      if (current.length === 0) return;
      batches.push(current);
      current = [];
      currentLen = 'Activity'.length;
    };

    for (const line of lines) {
      const nextLen = currentLen + 1 + line.length;
      const exceedLineLimit = current.length >= NORMAL_ACTIVITY_MAX_LINES_PER_MESSAGE;
      const exceedCharLimit = nextLen > NORMAL_ACTIVITY_MAX_CHARS_PER_MESSAGE;
      if (current.length > 0 && (exceedLineLimit || exceedCharLimit)) flushCurrent();

      current.push(line);
      currentLen += 1 + line.length;
    }

    flushCurrent();
    return batches;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async sendTextAfterConfirmation(
    uid: string,
    text: string,
    options: Parameters<ILinkClient['sendText']>[2],
    context: string,
  ): Promise<void> {
    try {
      await this.ilink.sendText(uid, text, options);
    } catch (err) {
      if (!isDeliveryFinalizationError(err)) throw err;
      log.error(`[${context}] 消息已确认，等待本地交付状态恢复:`, err);
    }
  }

  /** Oversized Normal-mode activity as titled batches; empty when one message suffices. */
  private normalActivityOutputs(lines: string[]): TaskOutput[] {
    const batches = this.splitNormalActivityLines(lines);
    if (batches.length <= 1) return [];
    return batches.map((batch, i) => ({
      text: [`Activity (${i + 1}/${batches.length})`, ...batch].join('\n'),
      priority: 'activity' as const,
      enqueued: false,
      ...(i < batches.length - 1 ? { delayAfterMs: NORMAL_ACTIVITY_SPLIT_DELAY_MS } : {}),
    }));
  }

  private async sendNormalActivityBatches(uid: string, lines: string[], generation?: number): Promise<boolean> {
    const outputs = this.normalActivityOutputs(lines);
    if (outputs.length === 0) return false;

    for (const output of outputs) {
      await this.sendTextAfterConfirmation(uid, output.text, { priority: 'activity', generation }, 'activity');
      if (output.delayAfterMs) await this.sleep(output.delayAfterMs);
    }
    return true;
  }


  private isAllowed(uid: string): boolean {
    return this.config.allowAllUsers || this.config.allowedUsers.includes(uid);
  }

  private accountId(): string {
    return (this.ilink as ILinkClient & { getAccountId?: () => string }).getAccountId?.call(this.ilink) || 'default-account';
  }

  private deliveryStatus(uid: string): DeliveryStatusView | undefined {
    return (this.ilink as ILinkClient & {
      getDeliveryStatus?: (userId: string) => DeliveryStatusView;
    }).getDeliveryStatus?.call(this.ilink, uid);
  }

  // ─── Durable inbound lifecycle (issue #27) ─────────────

  /**
   * Poll-path handler. Synchronously persists the inbound as a `received` task and
   * returns; the ILinkClient only completes the inbound and commits the poll cursor
   * after this returns, so a failure here leaves the inbound replayable. Agent work
   * runs in a background runner that never holds the poll request open.
   */
  private acceptInbound(msg: WeixinMessage, text: string, refText: string, media?: DownloadedMedia[]): void {
    const uid = msg.from_user_id;
    if (!this.isAllowed(uid)) return;
    const { task, created } = this.tasks.handoff({
      accountId: this.accountId(),
      userId: uid,
      messageId: String(msg.message_id),
      text,
      refText,
      media,
      generation: this.deliveryStatus(uid)?.quota.generation,
    });
    if (!created) log.debug(`[task] 入站重放，沿用已有任务 ${task.taskId} (${task.phase})`);
    if (task.phase === 'received') this.runInBackground(task.taskId, () => this.dispatchTask(task.taskId));
  }

  private runInBackground(taskId: string, work: () => Promise<void>): void {
    if (this.stopping || this.runners.has(taskId)) return;
    const runner: Promise<void> = Promise.resolve()
      .then(work)
      .catch((err) => log.error(`[task] ${taskId} 后台执行异常:`, err))
      .finally(() => {
        if (this.runners.get(taskId) === runner) this.runners.delete(taskId);
      });
    this.runners.set(taskId, runner);
  }

  private async dispatchTask(taskId: string): Promise<void> {
    // The durable claim is the cross-replay guard: only a `received` task can be
    // claimed, so a concurrent replay or a second runner finds nothing to do.
    const task = this.tasks.claim(taskId, this.bootId);
    if (!task) return;
    const run: TaskRun = { taskId, store: this.tasks, generation: task.inbound.generation };
    const msg = {
      message_id: Number(task.messageId) || 0,
      from_user_id: task.userId,
      to_user_id: '',
      client_id: '',
      create_time_ms: task.createdAt,
      message_type: 1,
      message_state: 0,
      context_token: '',
      item_list: [],
    } as WeixinMessage;
    try {
      await this.handle(msg, task.inbound.text, task.inbound.refText, task.inbound.media, run);
    } catch (err) {
      log.error(`[task] ${taskId} 处理失败:`, err);
      if (this.stopping) return;
      const current = this.tasks.get(taskId);
      if (current?.phase === 'dispatching') {
        this.tasks.complete(taskId, 'handler-error', errorMessage(err));
      } else if (current?.phase === 'running') {
        this.enterRecovery(current, 'runner-error', `runner threw while the agent phase was open: ${errorMessage(err)}`);
        await this.resumeTaskDelivery(taskId);
      }
      return;
    }
    if (this.stopping) return;
    if (this.tasks.get(taskId)?.phase === 'dispatching') this.tasks.complete(taskId, 'no-agent');
  }

  /**
   * Restart reconciliation. Runs synchronously before any delivery so that
   * outputs a previous boot enqueued (but crashed before recording) are matched
   * against the outbox while nothing can drain it yet.
   */
  private recoverTasks(): void {
    const live = this.tasks.list({ phases: ['received', 'dispatching', 'running', 'delivery-pending', 'recovery-required'] });
    const resumable: string[] = [];
    for (const task of live) {
      try {
        if (task.phase === 'received') {
          resumable.push(task.taskId);
          continue;
        }
        if ((task.phase === 'dispatching' || task.phase === 'running') && task.runner?.bootId !== this.bootId) {
          this.enterRecovery(
            task,
            task.phase === 'running' ? 'agent-interrupted' : 'interrupted-during-dispatch',
            task.phase === 'running'
              ? `agent ${task.agent?.tool ?? '?'} was executing when boot ${task.runner?.bootId ?? '?'} stopped; its outcome was never recorded`
              : `boot ${task.runner?.bootId ?? '?'} stopped after claiming the task and before any agent started`,
          );
        }
        const current = this.tasks.get(task.taskId);
        if (current && (current.phase === 'delivery-pending' || current.phase === 'recovery-required')) {
          this.reconcileEnqueuedOutputs(current);
          resumable.push(task.taskId);
        }
      } catch (err) {
        log.error(`[task] 恢复任务 ${task.taskId} 失败:`, err);
      }
    }
    for (const taskId of resumable) {
      const task = this.tasks.get(taskId);
      if (task?.phase === 'received') this.runInBackground(taskId, () => this.dispatchTask(taskId));
      else if (task && this.needsDeliveryResume(task)) {
        this.runInBackground(taskId, () => this.resumeTaskDelivery(taskId));
      }
    }
  }

  private enterRecovery(task: InboundTask, reason: RecoveryReason, detail: string): void {
    const tool = task.agent?.tool;
    const snippet = task.inbound.text.length > 60 ? `${task.inbound.text.slice(0, 60)}…` : task.inbound.text;
    const text = reason === 'interrupted-during-dispatch'
      ? `⚠️ 桥接服务在处理你的消息时中断（尚未调用 Agent）。为避免重复执行，没有自动重试。\n原消息: ${snippet}\n如需执行请重新发送；/tasks 查看详情。`
      : reason === 'runner-error'
        ? `⚠️ 处理你的消息时桥接服务内部出错，${tool ?? 'Agent'} 可能已开始执行，无法确认它是否已完成或已产生副作用，因此不会自动重跑。\n原消息: ${snippet}\n请检查工作区状态后再决定是否重新发送；/tasks 查看详情。`
        : `⚠️ 桥接服务中断时 ${tool ?? 'Agent'} 仍在执行你的消息，无法确认它是否已完成或已产生副作用，因此不会自动重跑。\n原消息: ${snippet}\n请检查工作区状态后再决定是否重新发送；/tasks 查看详情。`;
    this.tasks.requireRecovery(task.taskId, {
      reason,
      at: Date.now(),
      phase: task.phase,
      ownerBootId: task.runner?.bootId,
      detectedByBootId: this.bootId,
      tool,
      agentStartedAt: task.agent?.startedAt,
      detail,
    }, { text, priority: 'final', enqueued: false });
    log.warn(`[task] ${task.taskId} → recovery-required (${reason}): ${detail}`);
  }

  /** Delivery may still be owed: outputs not yet built/enqueued, or enqueued chunks still queued. */
  private needsDeliveryResume(task: InboundTask): boolean {
    if (task.phase === 'delivery-pending') return true;
    if (task.phase !== 'recovery-required' || !task.outputs) return false;
    if (task.outputs.some((_output, index) => !this.isOutputEnqueued(task, index))) return true;
    return this.hasPendingTaskItems(task.userId, { taskId: task.taskId, store: this.tasks });
  }

  /** Does this user have task output still owed (other than `excludeTaskId`)? */
  private hasOwedTaskDelivery(uid: string, excludeTaskId?: string): boolean {
    return this.tasks.list({ userId: uid, phases: ['delivery-pending', 'recovery-required'] })
      .some((task) => task.taskId !== excludeTaskId && this.needsDeliveryResume(task));
  }

  private isOutputEnqueued(task: InboundTask, index: number): boolean {
    return Boolean(task.outputs?.[index]?.enqueued) || this.enqueuedNotRecorded.has(`${task.taskId}#${index}`);
  }

  private taskItemIds(task: InboundTask): Set<string> {
    const ids = new Set(task.outputs?.flatMap((output) => output.itemIds || []) || []);
    task.outputs?.forEach((_output, index) => {
      for (const id of this.enqueuedNotRecorded.get(`${task.taskId}#${index}`) || []) ids.add(id);
    });
    return ids;
  }

  private outputPrefix(taskId: string, index: number): string {
    return `${taskId}:o${index}`;
  }

  /** Mark outputs whose chunks already sit in the outbox (crash between enqueue and record). */
  private reconcileEnqueuedOutputs(task: InboundTask): void {
    if (!task.outputs?.some((output) => !output.enqueued)) return;
    const status = this.deliveryStatus(task.userId);
    const known = [...(status?.pending || []), ...(status?.failed || [])].map((item) => item.itemId);
    task.outputs.forEach((output, index) => {
      if (output.enqueued) return;
      const prefix = `${this.outputPrefix(task.taskId, index)}#`;
      const ids = known.filter((itemId) => itemId.startsWith(prefix));
      if (ids.length > 0) this.tasks.markOutputEnqueued(task.taskId, index, ids);
    });
  }

  /** Each fresh inbound may open a delivery window: re-drive this user's unfinished task output. */
  private resumeUserTasks(uid: string, excludeTaskId?: string): Promise<void> {
    const runs: Promise<void>[] = [];
    for (const task of this.tasks.list({ userId: uid, phases: ['delivery-pending', 'recovery-required'] })) {
      if (task.taskId === excludeTaskId || !this.needsDeliveryResume(task)) continue;
      this.runInBackground(task.taskId, () => this.resumeTaskDelivery(task.taskId));
      const runner = this.runners.get(task.taskId);
      if (runner) runs.push(runner);
    }
    return Promise.allSettled(runs).then(() => undefined);
  }

  /** Delivery-only resume: never touches an adapter. */
  private async resumeTaskDelivery(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    try {
      await this.deliverTask(task.userId, { taskId, store: this.tasks });
    } catch (err) {
      log.error(`[task] ${taskId} 交付暂停，等待下次入站或重启后继续:`, err);
    }
  }

  private ephemeralRun(uid: string, generation?: number): TaskRun {
    const store = new InboundTaskStore();
    const { task } = store.handoff({
      accountId: this.accountId(),
      userId: uid,
      messageId: `adhoc-${randomUUID()}`,
      text: '',
      refText: '',
      generation,
    });
    store.claim(task.taskId, this.bootId);
    return { taskId: task.taskId, store, generation };
  }

  /** running → delivery-pending. If the ledger cannot be written, deliver from an
   *  ephemeral copy: the durable task stays `running` and the next boot reports
   *  it as recovery-required instead of silently claiming success. */
  private commitOutcome(run: TaskRun, outcome: DeliveryOutcome): TaskRun {
    // Without a media step the final message sequence is already known: record the
    // outcome and its outputs in one write instead of two.
    const outputs = outcome.kind === 'texts' || !sendFileMarkerRegex().test(outcome.text)
      ? this.buildOutputs(outcome, { sent: [], failed: [] })
      : undefined;
    try {
      run.store.recordOutcome(run.taskId, this.bootId, outcome, outputs);
      return run;
    } catch (err) {
      log.error(`[task] 无法持久化 ${run.taskId} 的 Agent 结果，将尽力直接发送:`, err);
      const fallback = this.ephemeralRun(this.tasks.get(run.taskId)?.userId ?? '', outcome.generation);
      fallback.store.markRunning(fallback.taskId, this.bootId, 'fallback');
      fallback.store.recordOutcome(fallback.taskId, this.bootId, outcome, outputs);
      return fallback;
    }
  }

  private settleAborted(run: TaskRun): void {
    // A shutdown abort is an interruption, not a user cancel: leave the phase so
    // the next boot classifies it as recovery-required.
    if (this.stopping) return;
    try {
      run.store.complete(run.taskId, 'cancelled');
    } catch (err) {
      log.error(`[task] 无法记录 ${run.taskId} 已取消:`, err);
    }
  }

  /**
   * Drive a delivery-pending (or recovery-required notice) task to the outbox.
   * Every step is recorded, so a resume skips what is already durable.
   */
  private async deliverTask(uid: string, run: TaskRun): Promise<void> {
    let task = run.store.get(run.taskId);
    if (!task) return;
    if (task.phase === 'delivery-pending' && task.outcome && !task.outputs) {
      const files = task.outcome.kind === 'exec'
        ? await this.deliverTaskFiles(uid, run, task.outcome)
        : { sent: [], failed: [] };
      task = run.store.setOutputs(run.taskId, this.buildOutputs(task.outcome, files));
    }
    await this.sendTaskOutputs(uid, run);
    if (this.hasPendingTaskItems(uid, run)) {
      // Output a previous runner already enqueued is still queued: drain the
      // outbox (FIFO, quota- and receipt-aware) rather than enqueueing again.
      const recoverPending = (this.ilink as ILinkClient & {
        recoverPending?: (userId: string) => Promise<unknown>;
      }).recoverPending;
      await recoverPending?.call(this.ilink, uid);
    }
    this.settleDelivery(uid, run);
  }

  private hasPendingTaskItems(uid: string, run: TaskRun): boolean {
    const task = run.store.get(run.taskId);
    const itemIds = task ? this.taskItemIds(task) : new Set<string>();
    if (itemIds.size === 0) return false;
    return (this.deliveryStatus(uid)?.pending || []).some((item) => itemIds.has(item.itemId));
  }

  private async deliverTaskFiles(
    uid: string,
    run: TaskRun,
    outcome: ExecDeliveryOutcome,
  ): Promise<{ sent: string[]; failed: string[] }> {
    let task = run.store.get(run.taskId)!;
    if (!task.files) task = run.store.setFiles(run.taskId, this.extractSendFiles(uid, outcome.text));
    const files = task.files || [];
    const sent: string[] = [];
    // Failures used to be log-only, so a file that never sent looked identical to a
    // successful one from inside WeChat. Collect them and report back to the user.
    const failed: string[] = [];
    for (let index = 0; index < files.length; index++) {
      let file = files[index];
      if (file.state === 'sending') {
        // A previous runner started this media send and never recorded the result.
        // Media sends are not idempotent, so report instead of resending.
        file = run.store.setFileState(run.taskId, index, 'unknown', '发送中断，无法确认是否已送达，未重发').files![index];
      }
      if (file.state === 'pending') {
        if (!existsSync(file.path)) {
          log.warn(`[SEND_FILE] 文件不存在: ${file.path}`);
          file = run.store.setFileState(run.taskId, index, 'failed', '文件不存在').files![index];
        } else {
          run.store.setFileState(run.taskId, index, 'sending');
          try {
            const ext = file.path.split('.').pop()?.toLowerCase();
            if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext || '')) {
              await this.ilink.sendImage(uid, file.path);
            } else if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext || '')) {
              await this.ilink.sendVideo(uid, file.path);
            } else {
              await this.ilink.sendFile(uid, file.path);
            }
            log.info(`[SEND_FILE] 已发送: ${file.path}`);
            file = run.store.setFileState(run.taskId, index, 'sent').files![index];
          } catch (err) {
            log.error(`[SEND_FILE] 发送失败: ${file.path}`, err);
            file = run.store.setFileState(run.taskId, index, 'failed', (err as Error).message || '未知错误').files![index];
          }
        }
      }
      if (file.state === 'sent') sent.push(file.baseName);
      else failed.push(`${file.baseName}（${file.error || '未知错误'}）`);
    }
    return { sent, failed };
  }

  private extractSendFiles(uid: string, text: string): TaskFileStep[] {
    const regex = sendFileMarkerRegex();
    const workDir = this.sessions.get(uid).workDir || this.config.workDir;
    const files: TaskFileStep[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      let filePath = match[1].trim();
      // 处理相对路径
      if (!filePath.match(/^[A-Za-z]:/) && !filePath.startsWith('/')) {
        filePath = join(workDir, filePath);
      }
      files.push({ path: filePath, baseName: filePath.split(/[\\/]/).pop() || filePath, state: 'pending' });
    }
    return files;
  }

  /** The exact message sequence the pre-#27 exec() sent after the Agent returned. */
  private buildOutputs(outcome: DeliveryOutcome, files: { sent: string[]; failed: string[] }): TaskOutput[] {
    if (outcome.kind === 'texts') {
      return outcome.texts.map((text) => ({ ...text, enqueued: false }));
    }
    const outputs: TaskOutput[] = [];
    const cleanText = outcome.text.replace(sendFileMarkerRegex(), '').trim();

    // Send thinking content if enabled (only in compact mode, non-compact already streamed)
    if (outcome.showThoughts && outcome.thinking && outcome.msgMode === 'compact') {
      outputs.push({ text: `💭 思考:\n${outcome.thinking}\n\n---`, priority: 'intermediate', enqueued: false });
    }

    const sentNotice = [
      files.sent.length > 0 ? `\n[已发送文件: ${files.sent.join(', ')}]` : '',
      files.failed.length > 0 ? `\n[⚠️ 文件发送失败: ${files.failed.join('; ')}]` : '',
    ].join('');

    const activityOutputs = outcome.msgMode === 'normal' && outcome.finalActivityLines.length > 0
      ? this.normalActivityOutputs(outcome.finalActivityLines)
      : [];
    outputs.push(...activityOutputs);

    const finalActivityBlock = outcome.msgMode === 'normal' && outcome.finalActivityLines.length > 0 && activityOutputs.length === 0
      ? `Activity\n${outcome.finalActivityLines.join('\n')}\n\n`
      : '';
    const meta = { tool: outcome.displayName, duration: outcome.duration, error: outcome.error };

    // If text was already streamed, only send footer (avoid duplicate large-body resend).
    if (outcome.hasStreamedText) {
      const tailNotice = outcome.intermediateSendFailed
        ? `${outcome.notice}[部分中间消息发送失败]${sentNotice}`
        : `${outcome.notice}${sentNotice}`;
      outputs.push({ text: formatResponse(`${finalActivityBlock}${tailNotice}`.trim(), meta), priority: 'final', enqueued: false });
    } else {
      // compact mode or no streamed text: send full result
      outputs.push({
        text: formatResponse(`${finalActivityBlock}${outcome.notice}${cleanText}${sentNotice}`, meta),
        priority: 'final',
        enqueued: false,
      });
    }
    return outputs;
  }

  private async sendTaskOutputs(uid: string, run: TaskRun): Promise<void> {
    const task = run.store.get(run.taskId);
    if (!task?.outputs) return;
    const generation = task.outcome?.generation ?? task.inbound.generation ?? run.generation;
    const outputs = task.outputs;
    for (let index = 0; index < outputs.length; index++) {
      const output = outputs[index];
      const memoKey = `${run.taskId}#${index}`;
      const unrecorded = this.enqueuedNotRecorded.get(memoKey);
      if (!output.enqueued && unrecorded) {
        // The outbox already holds this output; only the ledger mark is missing.
        try {
          run.store.markOutputEnqueued(run.taskId, index, unrecorded);
          this.enqueuedNotRecorded.delete(memoKey);
        } catch (err) {
          log.error(`[task] 仍无法记录 ${memoKey} 已入队:`, err);
        }
        continue;
      }
      if (!output.enqueued) {
        let recorded = false;
        const record = (itemIds: string[]): void => {
          if (recorded) return;
          recorded = true;
          try {
            run.store.markOutputEnqueued(run.taskId, index, itemIds);
          } catch (err) {
            // Never block or fail the send: the outbox has it. Remember it in memory so an
            // in-process resume does not enqueue it again (restart reconciles from the outbox).
            log.error(`[task] 输出已入队但无法记录 ${memoKey}:`, err);
            this.enqueuedNotRecorded.set(memoKey, itemIds);
          }
        };
        try {
          const results = await this.ilink.sendText(uid, output.text, {
            priority: output.priority,
            generation,
            itemIdPrefix: this.outputPrefix(run.taskId, index),
            onEnqueued: (items) => record(items.map((item) => item.itemId)),
          });
          record(Array.isArray(results) ? results.map((result) => result.itemId) : []);
        } catch (err) {
          if (!isDeliveryFinalizationError(err)) throw err;
          log.error(`[task:${output.priority}] 消息已确认，等待本地交付状态恢复:`, err);
          record([]);
        }
        if (output.delayAfterMs && index < outputs.length - 1) await this.sleep(output.delayAfterMs);
      }
    }
  }

  /** delivery-pending → completed once every output left the outbox's pending queue. */
  private settleDelivery(uid: string, run: TaskRun): void {
    const task = run.store.get(run.taskId);
    if (!task || task.phase !== 'delivery-pending' || !task.outputs) return;
    if (task.outputs.some((output) => !output.enqueued)) return;
    if (this.hasPendingTaskItems(uid, run)) return;
    // Items that ended in the outbox's failure retention (#26) stay owned by the
    // outbox (ambiguous ones are requeued on a later inbound); note them here.
    const itemIds = this.taskItemIds(task);
    const failed = (this.deliveryStatus(uid)?.failed || []).filter((item) => itemIds.has(item.itemId));
    run.store.complete(run.taskId, 'delivered', failed.length > 0 ? `failed items: ${failed.map((item) => item.itemId).join(', ')}` : undefined);
  }

  private async handle(
    msg: WeixinMessage,
    text: string,
    refText: string,
    media?: DownloadedMedia[],
    run?: TaskRun,
  ): Promise<void> {
    const uid = msg.from_user_id;
    if (!this.isAllowed(uid)) return;
    const deliveryClient = this.ilink as ILinkClient & {
      recoverPending?: (userId: string) => Promise<unknown>;
    };
    const deliveryStatus = this.deliveryStatus(uid);
    const taskGeneration = run ? run.generation : deliveryStatus?.quota.generation;

    const trimmed = text.trim();

    // Any fresh inbound may be the user's request to resume durable output.
    // The exact bare command is consumed; all other text continues normally.
    const recoverPending = deliveryClient.recoverPending;
    // Owed task output counts too: an output that never reached the outbox (e.g. a
    // failed enqueue) leaves `pending` empty, but 继续 must still only resume delivery.
    const owesOutbox = Boolean(deliveryStatus?.pending?.length);
    if (trimmed === '继续' && (owesOutbox || this.hasOwedTaskDelivery(uid, run?.taskId))) {
      const stopTyping = await this.ilink.startTyping(uid);
      try {
        await recoverPending?.call(this.ilink, uid);
      } catch (err) {
        log.error(`[delivery] 恢复 ${uid} 的排队消息失败:`, err);
      }
      try {
        await this.resumeUserTasks(uid, run?.taskId);
      } finally {
        stopTyping();
      }
      return;
    }
    if (recoverPending) {
      try {
        await recoverPending.call(this.ilink, uid);
      } catch (err) {
        log.error(`[delivery] 恢复 ${uid} 的排队消息失败:`, err);
      }
    }
    void this.resumeUserTasks(uid, run?.taskId);

    // Build media context for CLI
    let mediaContext = '';
    if (media && media.length > 0) {
      const mediaInfo = media.map(m => {
        const typeNames: Record<string, string> = { image: '图片', file: '文件', video: '视频' };
        return `${typeNames[m.type] || '媒体'}: ${m.fileName} (${m.path})`;
      });
      mediaContext = `\n\n[收到媒体文件]\n${mediaInfo.join('\n')}`;
    }

    // ── /command ──
    if (trimmed.startsWith('/')) {
      await this.handleSlash(uid, trimmed, taskGeneration, run);
      return;
    }

    // ── A waiting AskUser question / tool approval takes the reply before anything else ──
    if (trimmed && await this.answerInteraction(uid, trimmed)) return;
    const staleHint = trimmed ? this.staleAnswerHint(uid, trimmed) : undefined;
    if (staleHint) { await this.ilink.sendText(uid, staleHint, { priority: 'control' }); return; }

    // ── Parse: @tool1>tool2 chain, @tool single, >> relay, plain text ──

    // Pattern: @tool1>tool2 prompt  →  chain: tool1 processes, output feeds tool2
    const chainMatch = trimmed.match(/^@([\w-]+)>([\w-]+)(?:\s+([\s\S]*))?$/);
    if (chainMatch) {
      // A chain that can't run as written is refused: falling back to one tool (or the default)
      // would run the prompt somewhere the user didn't send it.
      const problem = this.chainProblem(chainMatch[1], chainMatch[2]);
      if (problem) { await this.ilink.sendText(uid, problem); return; }
      const prompt = (chainMatch[3] ?? '').trim();
      if (!prompt) { await this.ilink.sendText(uid, `用法: @${chainMatch[1]}>${chainMatch[2]} <内容>`); return; }
      const t1 = this.resolveToolName(chainMatch[1])!;
      const t2 = this.resolveToolName(chainMatch[2])!;
      const busy = [t1, t2].find(t => this.active.has(`${uid}:${t}`));
      if (busy) { await this.ilink.sendText(uid, this.busyText(uid, busy)); return; }
      await this.chain(uid, t1, t2, prompt + mediaContext, media, taskGeneration, run);
      return;
    }

    // Pattern: >> prompt  →  relay: prepend last response as context
    if (trimmed.startsWith('>>')) {
      const rest = trimmed.substring(2).trim();
      const prev = this.lastResponse.get(uid);
      if (!prev) {
        await this.ilink.sendText(uid, '没有上一条回复可接力');
        return;
      }
      const atRelayMatch = rest.match(/^@([\w-]+)[\s：:]\s*([\s\S]+)$/);
      const prompt = atRelayMatch ? atRelayMatch[2].trim() : rest;
      const toolName = this.getCli(uid, rest, refText);
      this.sessions.update(uid, { defaultTool: toolName });
      if (this.active.has(`${uid}:${toolName}`)) { await this.ilink.sendText(uid, this.busyText(uid, toolName)); return; }
      const fullPrompt = `以下是 ${prev.tool} 的输出:\n\n${prev.text}\n\n---\n\n${prompt}${mediaContext}`;
      await this.exec(uid, toolName, fullPrompt, media, taskGeneration, run);
      return;
    }

    // ── @mention 合法性校验 ──
    const atMatch = trimmed.match(/^@([\w-]+)(?:[\s：:]\s*([\s\S]+))?$/);
    const mentioned = atMatch ? this.resolveToolName(atMatch[1]) : undefined;
    if (atMatch && !mentioned) {
      await this.ilink.sendText(uid, `未知终端: @${atMatch[1]}\n可用: ${this.availableToolList()}`);
      return;
    }
    if (mentioned && !this.registry.isAvailable(mentioned)) {
      // Never fall back to the default tool: the prompt was addressed to someone else.
      await this.ilink.sendText(uid, `"${mentioned}" 未安装或不可用\n可用: ${this.availableToolList()}`);
      return;
    }

    const toolName = this.getCli(uid, trimmed, refText);

    // ── getCli 决定终端，立即切换 defaultTool ──
    this.sessions.update(uid, { defaultTool: toolName });

    if (!this.registry.isAvailable(toolName)) {
      await this.ilink.sendText(uid, `"${toolName}" 不可用\n可用: ${this.availableToolList()}`);
      return;
    }

    // @tool 无 prompt → 仅切换，确认后返回
    if (atMatch && !atMatch[2]) {
      await this.ilink.sendText(uid, `已切换到 ${toolName}`);
      return;
    }

    if (this.active.has(`${uid}:${toolName}`)) { await this.ilink.sendText(uid, this.busyText(uid, toolName)); return; }

    const prompt = atMatch ? atMatch[2].trim() : trimmed;
    const combined = [prompt, refText].filter(Boolean).join('\n\n') + mediaContext;
    await this.exec(uid, toolName, combined, media, taskGeneration, run);
  }

  // ─── /command → ALL are commands, never pass through ────

  private currentTool(uid: string): string {
    return this.sessions.get(uid).defaultTool || this.config.defaultTool;
  }

  private toolCapabilities(tool: string): Partial<AdapterCapabilities> {
    return this.registry.get(tool)?.capabilities ?? {};
  }

  /** /set keys the given tool reads (bridge-side keys apply to every tool). */
  private settingsFor(tool: string): SettingDef[] {
    return SETTINGS.filter((def) => !def.tools || def.tools.includes(tool));
  }

  private formatSetting(def: SettingDef, settings: UserSettings): string {
    const value = settings[def.field] as unknown;
    if (def.type === 'bool') return value ? 'ON' : 'OFF';
    if (def.type === 'money') return Number(value) > 0 ? `$${value}` : '无限';
    if (value === '' || value === undefined || value === null) return '无';
    return String(value);
  }

  /** `/set` → text of the reply. Bare `/set` lists the current tool's keys with their values. */
  private applySet(uid: string, arg: string): string {
    const settings = this.sessions.get(uid);
    const tool = this.currentTool(uid);
    const [rawKey = '', ...rest] = arg.split(/\s+/).filter(Boolean);
    const key = rawKey.toLowerCase();
    const value = rest.join(' ').trim();
    if (!key || key === 'all') {
      const defs = key === 'all' ? SETTINGS : this.settingsFor(tool);
      const lines = defs.map((def) => `${def.key} = ${this.formatSetting(def, settings)}  — ${def.hint}${key === 'all' && def.tools ? ` (${def.tools.join('/')})` : ''}`);
      return `${key === 'all' ? '全部设置' : `${tool} 的设置`}:\n${lines.join('\n')}\n\n/set <键> <值> 修改${key === 'all' ? '' : '，/set all 查看所有工具'}`;
    }
    const def = SETTINGS.find((d) => d.key === key);
    if (!def) return `未知设置: ${rawKey}\n/set 查看可设项`;

    let next: unknown;
    const lower = value.toLowerCase();
    switch (def.type) {
      case 'bool':
        // No value toggles, like the old one-word commands did.
        if (!value) next = !settings[def.field];
        else if (['on', 'true', '1', 'yes', '开'].includes(lower)) next = true;
        else if (['off', 'false', '0', 'no', '关'].includes(lower)) next = false;
        else return `${def.key} 只接受 on/off\n当前: ${this.formatSetting(def, settings)}`;
        break;
      case 'int': {
        const n = Number(value);
        if (!value || !Number.isInteger(n) || n < 1) return `当前: ${def.key} = ${this.formatSetting(def, settings)}\n/set ${def.key} <正整数>  ${def.hint}`;
        next = n;
        break;
      }
      case 'money': {
        if (!value) return `当前: ${def.key} = ${this.formatSetting(def, settings)}\n/set ${def.key} <美元> 或 off`;
        const n = lower === 'off' ? 0 : Number(value);
        if (!Number.isFinite(n) || n < 0) return `/set ${def.key} <美元> 或 off`;
        next = n;
        break;
      }
      case 'text':
        if (!value) return `当前: ${def.key} = ${this.formatSetting(def, settings)}\n/set ${def.key} <值>（off 清除）  ${def.hint}`;
        next = ['off', 'reset', 'clear'].includes(lower) ? '' : value;
        break;
      case 'enum':
        next = def.values![lower];
        if (next === undefined) {
          return `${value ? `无效值: ${value}\n` : ''}当前: ${def.key} = ${this.formatSetting(def, settings)}\n/set ${def.key} <${def.hint.split(' ')[0]}>`;
        }
        break;
    }
    this.sessions.update(uid, { [def.field]: next } as Partial<UserSettings>);
    const lines = [`${def.key} → ${this.formatSetting(def, this.sessions.get(uid))}`];
    if (def.tools && !def.tools.includes(tool)) lines.push(`(当前工具 ${tool} 不使用此项，对 ${def.tools.join('/')} 生效)`);
    const now = this.sessions.get(uid);
    if ((def.key === 'msgmode' || def.key === 'thoughts') && now.showThoughts && this.normalizeMsgMode(now.msgMode) === 'verbose') {
      lines.push('', THOUGHTS_VERBOSE_WARNING);
    }
    return lines.join('\n');
  }

  private helpText(uid: string): string {
    const tool = this.currentTool(uid);
    const caps = this.toolCapabilities(tool);
    const tools = this.availableTools();
    const shortcuts = tools.filter((t) => t.short).map((t) => `/${t.short}`).join(' ');
    const keys = this.settingsFor(tool).map((def) => def.key).join(' ');
    return [
      `=== cli-in-wechat 命令 (当前: ${this.registry.get(tool)?.displayName ?? tool}) ===`,
      '',
      '— 工具 —',
      `/use [名字]  切工具/列出可用 (${tools.map((t) => t.name).join(' ') || '无'})`,
      ...(shortcuts ? [`${shortcuts}  快捷切换`] : []),
      '/status  当前配置',
      '',
      '— 设置 —',
      ...(caps.hasModel ? ['/model <名|default>  切模型'] : []),
      ...(tool === 'opencode' ? ['/models  查看可用模型'] : []),
      ...(caps.modes?.length ? [`/mode <${caps.modes.join('|')}>  权限`] : []),
      ...(caps.hasEffort ? ['/effort <low|med|high|xhigh|max>  深度'] : []),
      '/dir <路径>  工作目录',
      `/set [键] [值]  其他设置 (${keys})`,
      '/reset  重置所有设置',
      '',
      '— 会话 —',
      '/new  新会话',
      ...(caps.sessionResume ? ['/resume [编号|id]  历史会话'] : []),
      '/cancel  取消任务',
      '/tasks [ack]  查看/确认中断的任务',
      '/send <路径>  发送文件到微信',
      '/diff /commit /review  常用操作',
      '/stats  上次回复统计',
      '',
      '— 发消息 —',
      '@<工具名>  单次指定工具',
      '>>  接力(传上条结果)',
      '@tool1>tool2  链式调用',
    ].join('\n');
  }

  private statusText(uid: string): string {
    const settings = this.sessions.get(uid);
    const tool = this.currentTool(uid);
    const caps = this.toolCapabilities(tool);
    const displayName = this.registry.get(tool)?.displayName;
    const sessionId = settings.sessionIds?.[tool];
    const changed = this.settingsFor(tool)
      .filter((def) => def.key !== 'msgmode' && def.key !== 'thoughts'
        && settings[def.field] !== undefined && settings[def.field] !== DEFAULT_SETTINGS[def.field])
      .map((def) => `${def.key}=${this.formatSetting(def, settings)}`);
    const lines = [
      `工具: ${tool}${displayName ? ` (${displayName})` : ''}`,
      `模式: ${settings.mode ?? DEFAULT_SETTINGS.mode}`,
      ...(caps.hasModel ? [`model: ${settings.model || '默认'}`] : []),
      ...(caps.hasEffort ? [`effort: ${settings.effort ?? DEFAULT_SETTINGS.effort}`] : []),
      `msgMode: ${this.normalizeMsgMode(settings.msgMode)} (默认: ${this.getDefaultMsgMode()})  thoughts: ${settings.showThoughts ? 'ON' : 'OFF'}`,
      ...(changed.length > 0 ? [`设置: ${changed.join(' ')}`] : []),
      `dir: ${settings.workDir || this.config.workDir}`,
      ...(caps.sessionResume ? [`会话: ${sessionId ? String(sessionId).substring(0, 12) : '无'}`] : []),
      `可用: ${this.availableToolList()}`,
    ];
    const getDeliveryStatus = (this.ilink as ILinkClient & {
      getDeliveryStatus?: (userId: string) => {
        quota: { sentItems: number; remainingItems: number; maxItemsPerWindow: number; rateBackoffUntil: number };
        pending: unknown[];
        failed: unknown[];
      };
    }).getDeliveryStatus;
    if (getDeliveryStatus) {
      const delivery = getDeliveryStatus.call(this.ilink, uid);
      const backoff = delivery.quota.rateBackoffUntil > Date.now() ? 'backoff' : 'ready';
      lines.push(`delivery: pending=${delivery.pending.length} failed=${delivery.failed.length} sent=${delivery.quota.sentItems}/${delivery.quota.maxItemsPerWindow} remaining=${delivery.quota.remainingItems} ${backoff}`);
    }
    const openTasks = this.tasks.list({ userId: uid, phases: ['delivery-pending', 'recovery-required'] });
    if (openTasks.length > 0) {
      const count = (phase: string) => openTasks.filter((task) => task.phase === phase).length;
      lines.push(`tasks: delivery-pending=${count('delivery-pending')} recovery-required=${count('recovery-required')} (/tasks)`);
    }
    return lines.join('\n');
  }

  private async handleSlash(uid: string, text: string, taskGeneration?: number, run?: TaskRun): Promise<boolean> {
    const parts = text.substring(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim();
    const settings = this.sessions.get(uid);
    const reply = (msg: string) => this.ilink.sendText(uid, msg);

    // Old per-CLI switches still work for one release, with a pointer to the new form.
    if (MOVED_TO_SET[cmd]) {
      const key = MOVED_TO_SET[cmd];
      await reply(`(/${cmd} 已改为 /set ${key})\n${this.applySet(uid, `${key} ${arg}`)}`);
      return true;
    }
    if (REMOVED_COMMANDS[cmd]) {
      await reply(`/${cmd} ${REMOVED_COMMANDS[cmd]}`);
      return true;
    }

    switch (cmd) {
      case 'help': case 'h':
        await reply(this.helpText(uid));
        return true;

      case 'status': case 'st':
        await reply(this.statusText(uid));
        return true;

      case 'set':
        await reply(this.applySet(uid, arg));
        return true;

      case 'models': {
        try {
          const stdout = execSync('opencode models', {
            cwd: settings.workDir || this.config.workDir,
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          const models = ordinaryOpenCodeModels(stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
          await reply(models.length > 0 ? `可用模型 (${models.length}个):\n${models.join('\n')}` : '没有可用的模型');
        } catch (err) {
          await reply(`获取模型列表失败: ${(err as Error).message}`);
        }
        return true;
      }

      case 'new': case 'n': case 'clear': case 'compact': case 'compress': case 'summarize':
        this.sessions.clearSession(uid);
        this.clearSessionGrants(uid);
        if (cmd === 'clear') this.lastResponse.delete(uid);
        await reply(cmd === 'clear' ? '已清除所有会话和接力内容' : '新会话');
        return true;

      case 'cancel': case 'c': {
        const tasks = [...this.active.entries()].filter(([k]) => k.startsWith(`${uid}:`));
        if (tasks.length > 0) {
          const seen = new Set<AbortController>();
          tasks.forEach(([k, t]) => { if (!seen.has(t.abort)) { seen.add(t.abort); t.abort.abort(); } this.active.delete(k); });
          await reply(`已取消 ${[...new Set(tasks.map(([, t]) => t.tool))].join(', ')}`);
        } else { await reply('无任务'); }
        return true;
      }

      case 'tasks': {
        const recovery = this.tasks.list({ userId: uid, phases: ['recovery-required'] });
        if (arg === 'ack' || arg === 'clear') {
          for (const task of recovery) this.tasks.complete(task.taskId, 'operator-acknowledged');
          await reply(recovery.length > 0 ? `已确认 ${recovery.length} 个中断任务` : '没有需要确认的中断任务');
          return true;
        }
        const open = this.tasks.list({
          userId: uid,
          phases: ['received', 'dispatching', 'running', 'delivery-pending', 'recovery-required'],
        }).filter((task) => task.taskId !== run?.taskId);
        if (open.length === 0) { await reply('没有未完成的任务'); return true; }
        const lines = open.map((task) => {
          const snippet = task.inbound.text.length > 40 ? `${task.inbound.text.slice(0, 40)}…` : task.inbound.text;
          const when = new Date(task.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
          const parts = [`[${task.phase}] ${when} ${snippet}`];
          if (task.agent) parts.push(`  agent: ${task.agent.tool}`);
          if (task.recovery) parts.push(`  原因: ${task.recovery.reason} — ${task.recovery.detail}`);
          return parts.join('\n');
        });
        await reply(`未完成任务 (${open.length}):\n\n${lines.join('\n\n')}${recovery.length > 0 ? '\n\n/tasks ack 确认已处理中断任务' : ''}`);
        return true;
      }

      case 'model': case 'm': {
        const model = this.normalizeModelArg(arg);
        if (!model) {
          this.sessions.update(uid, { model: '' });
          await reply('model → 默认');
        } else {
          this.sessions.update(uid, { model });
          await reply(`model → ${model}`);
        }
        return true;
      }

      case 'mode': {
        const tool = this.currentTool(uid);
        const supported = this.toolCapabilities(tool).modes;
        const v = (['auto', 'safe', 'plan'] as const).find((mode) => mode === arg.toLowerCase());
        if (!v) {
          await reply(`当前: ${settings.mode}\n/mode <auto|safe|plan>\nauto=最高权限 safe=每次敏感操作在微信里问你 plan=只读`);
          return true;
        }
        this.sessions.update(uid, { mode: v });
        const note = MODE_NOTES[tool]?.[v];
        const lines = [MODE_MEANING[v]];
        if (note) lines.push(`${tool}: ${note}`);
        if (supported && !supported.includes(v)) lines.push(`(${tool} 不支持 ${v} 模式)`);
        if (tool === 'gemini' && settings.approvalMode) lines.push(`(已用 /set approval ${settings.approvalMode} 覆盖；/set approval off 恢复跟随 /mode)`);
        if (tool === 'codex' && settings.sandbox) lines.push(`(已用 /set sandbox ${settings.sandbox} 覆盖；/set sandbox off 恢复跟随 /mode)`);
        await reply(lines.join('\n'));
        return true;
      }

      case 'dir': case 'cd':
        if (!arg) { await reply(`当前: ${settings.workDir || this.config.workDir}`); return true; }
        this.sessions.update(uid, { workDir: arg });
        this.clearSessionGrants(uid);
        await reply(`dir → ${arg}`);
        return true;

      case 'effort': case 'e': {
        const map: Record<string, string> = {
          min: 'low', low: 'low', med: 'medium', medium: 'medium', high: 'high',
          xhigh: 'xhigh', xh: 'xhigh', max: 'max',
          '1': 'low', '2': 'low', '3': 'medium', '4': 'high', '5': 'max',
        };
        const v = map[arg.toLowerCase()];
        if (!v) { await reply(`当前: ${settings.effort}\n/effort <low|med|high|xhigh|max>`); return true; }
        this.sessions.update(uid, { effort: v });
        await reply(`effort → ${v}`);
        return true;
      }

      case 'reset':
        this.sessions.update(uid, {
          mode: 'auto', effort: 'high', model: '', maxTurns: 100, maxBudget: 0,
          allowedTools: '', disallowedTools: '', verbose: false, sandbox: '',
          search: false, systemPrompt: '', workDir: '', bare: false, addDir: '',
          sessionName: '', ephemeral: false, profile: '', approvalMode: '',
          includeDirs: '', extensions: '', showThoughts: false, msgMode: this.getDefaultMsgMode(),
        } as any);
        this.clearSessionGrants(uid);
        await reply('所有设置已重置');
        return true;

      // ── 操作类 (转化为 prompt 发给当前工具) ──

      case 'diff': case 'commit': case 'review': {
        const prompts: Record<string, string> = {
          diff: 'Show the current git diff of uncommitted changes. Be concise.',
          commit: 'Create a git commit for all staged changes with an appropriate commit message.',
          review: 'Review the current code changes (git diff) and provide feedback on quality, bugs, and improvements.',
        };
        const tool = this.currentTool(uid);
        if (this.registry.isAvailable(tool)) {
          await this.exec(uid, tool, arg || prompts[cmd], undefined, taskGeneration, run);
        }
        return true;
      }

      case 'cost': case 'usage': case 'stats': {
        const last = this.lastResponse.get(uid);
        if (last) {
          await reply(`上次回复:\n工具: ${last.tool}\n长度: ${last.text.length} 字符`);
        } else {
          await reply('暂无回复记录');
        }
        return true;
      }

      case 'send': {
        if (!arg) {
          await reply('/send <文件路径>\n发送本地文件到微信');
          return true;
        }
        try {
          const filePath = arg.trim();
          if (!existsSync(filePath)) {
            await reply(`文件不存在: ${filePath}`);
            return true;
          }
          const ext = filePath.split('.').pop()?.toLowerCase();
          if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext || '')) {
            await this.ilink.sendImage(uid, filePath);
            await reply(`已发送图片: ${filePath}`);
          } else if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext || '')) {
            await this.ilink.sendVideo(uid, filePath);
            await reply(`已发送视频: ${filePath}`);
          } else {
            await this.ilink.sendFile(uid, filePath);
            await reply(`已发送文件: ${filePath}`);
          }
        } catch (err) {
          await reply(`发送失败: ${(err as Error).message}`);
        }
        return true;
      }

      case 'resume': case 'sessions': {
        const tool = this.currentTool(uid);
        if (arg) {
          // /resume <number> → pick from this user's last list for this tool, or /resume <id> → direct set.
          // Switching to another session drops its "本会话自动允许" grants.
          const num = parseInt(arg);
          if (!isNaN(num) && String(num) === arg.trim()) {
            const listed = this.lastSessionLists.get(`${uid}:${tool}`);
            const workDir = settings.workDir || this.config.workDir;
            if (!listed || listed.workDir !== workDir) {
              await reply(`没有可选的 ${tool} 会话列表，先发 /resume 查看`);
              return true;
            }
            const pick = listed.items[num - 1];
            if (pick) {
              this.clearSessionGrants(uid);
              this.sessions.setSession(uid, tool, pick.id);
              await reply(`已恢复 ${tool} 会话:\n${pick.summary}\n\nID: ${pick.id}`);
            } else {
              await reply(`无效编号，范围 1-${listed.items.length}`);
            }
          } else {
            // Treat as a session id
            this.clearSessionGrants(uid);
            this.sessions.setSession(uid, tool, arg.trim());
            await reply(`${tool} session → ${arg.trim()}`);
          }
          return true;
        }
        // List all sessions for current tool
        const list = this.listSessions(tool, settings.workDir || this.config.workDir);
        if (list.length === 0) {
          await reply(`${tool} 没有历史会话`);
          return true;
        }
        this.lastSessionLists.set(`${uid}:${tool}`, { workDir: settings.workDir || this.config.workDir, items: list });
        const lines = list.map((s, i) =>
          `${i + 1}. ${s.date} ${s.summary}\n   ${s.id}`
        );
        await reply(`${tool} 历史会话 (最近${list.length}条):\n\n${lines.join('\n\n')}\n\n回复 /resume <编号> 恢复`);
        return true;
      }

      // ── 不适用于微信的命令 (给出说明) ──

      case 'vim': case 'theme': case 'color': case 'terminal-setup':
      case 'keybindings': case 'chrome': case 'ide': case 'stickers':
      case 'mobile': case 'ios': case 'android': case 'exit': case 'quit':
      case 'login': case 'logout': case 'doctor': case 'upgrade':
      case 'think-back': case 'thinkback':
      case 'output-style': case 'extra-usage': case 'rate-limit-options':
      case 'install-github-app': case 'install-slack-app':
      case 'setup-default-sandbox': case 'sandbox-add-read-dir':
      case 'collab': case 'realtime': case 'personality':
      case 'title': case 'statusline': case 'footer': case 'shortcuts':
      case 'setup-github': case 'remote-env': case 'reload-plugins':
      case 'debug-config':
        await reply(`/${cmd} 仅在本地终端可用，不适用于微信`);
        return true;

      // ── 工具切换 ──

      case 'use': case 'u': {
        if (arg) { await this.switchTool(uid, arg); return true; }
        const current = this.currentTool(uid);
        const tools = this.availableTools();
        if (tools.length === 0) { await reply('本机没有检测到可用的 CLI 工具'); return true; }
        const lines = tools.map((tool) =>
          `${tool.name === current ? '▶' : '  '} ${tool.name}  ${tool.displayName}${tool.short ? ` (/${tool.short})` : ''}`);
        await reply(`可用工具 (当前: ${current}):\n${lines.join('\n')}\n\n/use <名字> 切换，@<名字> 单次指定`);
        return true;
      }
      case 'claude': case 'cc': case 'codex': case 'cx': case 'gemini': case 'gm':
      case 'kimi': case 'km': case 'opencode': case 'oc':
        await this.switchTool(uid, cmd);
        return true;

      default:
        await reply(`未知命令: /${cmd}\n/help 查看所有命令`);
        return true;
    }
  }

  // ─── List historical sessions ───────────────────────────

  private listSessions(tool: string, workDir: string): Array<{ id: string; date: string; summary: string }> {
    try {
      // Claude: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
      // Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl
      // OpenCode: uses 'opencode session list --format json'
      let dir = '';
      if (tool === 'claude') {
        const encoded = workDir.replace(/[^a-zA-Z0-9]/g, '-');
        dir = join(homedir(), '.claude', 'projects', encoded);
      } else if (tool === 'codex') {
        dir = join(homedir(), '.codex', 'sessions');
        return this.listCodexSessions(dir);
      } else if (tool === 'opencode') {
        return this.listOpenCodeSessions(workDir);
      } else {
        return [];
      }

      const files = readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fullPath = join(dir, f);
          const id = f.replace('.jsonl', '');
          try {
            const stat = statSync(fullPath);
            const firstLines = readFileSync(fullPath, 'utf-8').split('\n').slice(0, 5);
            let summary = '(无摘要)';
            let date = stat.mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/\//g, '-');
            for (const line of firstLines) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line);
                if (obj.type === 'user' && obj.message?.content) {
                  let content = typeof obj.message.content === 'string'
                    ? obj.message.content
                    : obj.message.content.map((b: { text?: string }) => b.text || '').join('');
                  // 移除系统注入的提示
                  content = content.replace(/\n\n\[提示:.*?\]$/, '');
                  summary = content.substring(0, 60) + (content.length > 60 ? '...' : '');
                  if (obj.timestamp) {
                    const ts = new Date(obj.timestamp);
                    date = ts.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/\//g, '-');
                  }
                  break;
                }
              } catch { continue; }
            }
            return { id, date, summary, mtime: stat.mtime.getTime() };
          } catch {
            return { id, date: '', summary: '(读取失败)', mtime: 0 };
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 15);

      return files.map(({ id, date, summary }) => ({ id, date, summary }));
    } catch {
      return [];
    }
  }

  private listCodexSessions(baseDir: string): Array<{ id: string; date: string; summary: string }> {
    try {
      const results: Array<{ id: string; date: string; summary: string; mtime: number }> = [];
      const years = readdirSync(baseDir).filter(f => /^\d{4}$/.test(f));
      for (const year of years) {
        const months = readdirSync(join(baseDir, year)).filter(f => /^\d{2}$/.test(f));
        for (const month of months) {
          const days = readdirSync(join(baseDir, year, month)).filter(f => /^\d{2}$/.test(f));
          for (const day of days) {
            const dayDir = join(baseDir, year, month, day);
            const files = readdirSync(dayDir).filter(f => f.endsWith('.jsonl'));
            for (const f of files) {
              // rollout-<YYYY-MM-DDTHH-MM-SS>-<thread id>.jsonl: store the real thread id, which
              // `codex exec resume <id>` takes. The old 'last' sentinel resumed whatever ran last in
              // the cwd, crossing users that share a workDir.
              const m = f.match(/^rollout-\d{4}-\d{2}-\d{2}T(\d{2})-(\d{2})-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
              if (!m) continue;
              try {
                const stat = statSync(join(dayDir, f));
                results.push({
                  id: m[3],
                  date: `${year}-${month}-${day} ${m[1]}:${m[2]}`,
                  summary: `codex 会话 ${m[3].substring(0, 8)}`,
                  mtime: stat.mtime.getTime(),
                });
              } catch { continue; }
            }
          }
        }
      }
      return results.sort((a, b) => b.mtime - a.mtime).slice(0, 10).map(({ id, date, summary }) => ({ id, date, summary }));
    } catch {
      return [];
    }
  }

  private listOpenCodeSessions(workDir: string): Array<{ id: string; date: string; summary: string }> {
    try {
      const stdout = execSync('opencode session list --format json -n 15', {
        cwd: workDir,
        encoding: 'utf-8',
        timeout: 5000,
      });
      const sessions = JSON.parse(stdout);
      return sessions.map((s: { id: string; title: string; updated: number }) => {
        const date = new Date(s.updated).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/\//g, '-');
        return {
          id: s.id,
          date,
          summary: s.title || '(无标题)',
        };
      });
    } catch (err) {
      log.debug(`[opencode] session list failed: ${(err as Error).message}`);
      return [];
    }
  }

  // ─── Chain: tool1 → tool2 ─────────────────────────────

  private async chain(
    uid: string,
    tool1: string,
    tool2: string,
    prompt: string,
    media?: DownloadedMedia[],
    taskGeneration?: number,
    run?: TaskRun,
  ): Promise<void> {
    const adapter1 = this.registry.get(tool1);
    const adapter2 = this.registry.get(tool2);
    if (!adapter1 || !adapter2) return;

    const abort = new AbortController();
    this.active.set(`${uid}:${tool1}`, { abort, tool: `${tool1}>${tool2}` });
    this.active.set(`${uid}:${tool2}`, { abort, tool: `${tool1}>${tool2}` });
    const stopTyping = await this.ilink.startTyping(uid);
    const start = Date.now();
    run ??= this.ephemeralRun(uid, taskGeneration);

    try {
      run.store.markRunning(run.taskId, this.bootId, `${tool1}>${tool2}`);
      let outcome: DeliveryOutcome;
      try {
        // Step 1: run tool1
        log.debug(`[chain] step1: ${tool1}`);
        const { result: r1, notice: n1 } = await this.runOnce(tool1, uid, prompt, abort.signal, media);

        if (abort.signal.aborted) { this.settleAborted(run); return; }
        if (r1.error) {
          outcome = {
            kind: 'texts',
            texts: [{ text: formatResponse(n1 + r1.text, { tool: adapter1.displayName, error: true }), priority: 'final' }],
            generation: taskGeneration,
          };
        } else {
          if (r1.sessionId && adapter1.capabilities.sessionResume) {
            this.sessions.setSession(uid, tool1, r1.sessionId);
          }

          // Step 2: run tool2 with tool1's output as context
          log.debug(`[chain] step2: ${tool2}`);
          const chainPrompt = `以下是 ${adapter1.displayName} 对「${prompt}」的分析结果:\n\n${r1.text}\n\n---\n\n请基于以上内容继续工作。`;

          const { result: r2, notice: n2 } = await this.runOnce(tool2, uid, chainPrompt, abort.signal);

          if (abort.signal.aborted) { this.settleAborted(run); return; }

          if (r2.sessionId && adapter2.capabilities.sessionResume) {
            this.sessions.setSession(uid, tool2, r2.sessionId);
          }

          this.sessions.update(uid, { defaultTool: tool2 });
          this.lastResponse.set(uid, { tool: adapter2.displayName, text: r2.text });

          const elapsed = Date.now() - start;
          outcome = {
            kind: 'texts',
            texts: [{
              text: formatResponse(n2 + r2.text, {
                tool: `${adapter1.displayName} → ${adapter2.displayName}`,
                duration: elapsed,
                error: r2.error,
              }),
              priority: 'final',
            }],
            generation: taskGeneration,
          };
        }
      } catch (err: unknown) {
        if (abort.signal.aborted) { this.settleAborted(run); return; }
        log.error(`[chain] 失败:`, err);
        outcome = {
          kind: 'texts',
          texts: [{ text: `链式调用失败: ${(err as Error).message}`, priority: 'final' }],
          generation: taskGeneration,
        };
      }
      const deliveryRun = this.commitOutcome(run, outcome);
      try {
        await this.deliverTask(uid, deliveryRun);
      } catch (err) {
        log.error(`[chain] 交付暂停，等待下次入站或重启后继续:`, err);
      }
    } finally {
      stopTyping();
      this.active.delete(`${uid}:${tool1}`);
      this.active.delete(`${uid}:${tool2}`);
    }
  }

  // ─── Execute once, clean up stale session on failure ─
  // Executes the prompt exactly once. On failure, if a session was active,
  // clears it so the next request gets a fresh session — but does NOT
  // re-execute, because the prompt may have had side-effects.

  private async runOnce(
    toolName: string,
    uid: string,
    prompt: string,
    signal: AbortSignal,
    media?: DownloadedMedia[],
    onIntermediate?: (msg: import('../adapters/base.js').IntermediateMessage) => void,
  ): Promise<{ result: import('../adapters/base.js').ExecResult; notice: string }> {
    const adapter = this.registry.get(toolName)!;
    const extraArgs = this.config.tools[toolName]?.args;
    const initialSettings = this.sessions.get(uid);
    const normalizedModel = this.normalizeModelArg(initialSettings.model || '');
    if (normalizedModel !== initialSettings.model) {
      this.sessions.update(uid, { model: normalizedModel });
    }
    const settings = this.sessions.get(uid);
    const hadSession = adapter.capabilities.sessionResume && !!settings.sessionIds[toolName];
    const storedSession = settings.sessionIds[toolName];

    if (signal.aborted) return { result: { text: '已取消', error: true }, notice: '' };

    // 追加 SEND_FILE 提示到 prompt
    const sendFileHint = '\n\n[提示: 如果需要发送文件/图片到微信，在响应中包含标记 [SEND_FILE: 文件路径]]';
    const enhancedPrompt = prompt + sendFileHint;

    const result = await adapter.execute(enhancedPrompt, {
      settings, workDir: this.config.workDir, timeout: this.config.cliTimeout, extraArgs, signal,
      askUser: (req) => this.askUserViaWeChat(uid, toolName, req, signal),
      requestPermission: (req, adapterSignal) => this.requestPermissionViaWeChat(uid, toolName, req, [signal, adapterSignal]),
      media,
      onIntermediate,
    });

    if (result.sessionExpired && hadSession && !signal.aborted) {
      log.warn(`[${toolName}] 会话已过期，已清除旧会话`);
      this.sessions.clearSession(uid, toolName);
      return { result, notice: '[会话已过期并自动清除，如需重试请重新发送]\n\n' };
    }
    // An old sentinel ('last' / 'continue') is not resumable; adapters that store real ids start a
    // fresh session and hand back its id. Say so once — the real id replaces the sentinel.
    const sentinel = LEGACY_SESSION_SENTINELS[toolName];
    if (sentinel && storedSession === sentinel && result.sessionId && result.sessionId !== sentinel && !signal.aborted) {
      return { result, notice: '[旧版会话标记已失效，已开新会话]\n\n' };
    }
    return { result, notice: '' };
  }

  // ─── Execute single tool ──────────────────────────────

  // ─── Interactions: AskUser questions and tool approvals via WeChat ───

  /**
   * Queue a prompt for the user's reply. The promise always settles: with the parsed answer,
   * or with `onExpire(why)` on timeout, task cancel (any of `signals`), shutdown, an
   * undeliverable prompt or a second invalid reply. While it waits the task stays `running`.
   */
  private interact<T>(uid: string, spec: {
    toolName: string;
    waitingHint: string;
    freeText: boolean;
    text: string;
    retryText?: string;
    parse: (reply: string) => T | undefined;
    onExpire: (why: InteractionEnd) => T | Error;
    /** Checked when the interaction reaches the head: a value settles it without a message. */
    preempt?: () => T | undefined;
    signals?: Array<AbortSignal | undefined>;
  }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const signals = (spec.signals || []).filter((s): s is AbortSignal => Boolean(s));
      const finish = (): void => {
        item.done = true;
        clearTimeout(item.timer);
        for (const s of signals) s.removeEventListener('abort', onAbort);
        this.dropInteraction(uid, item);
      };
      const item: PendingInteraction = {
        toolName: spec.toolName,
        waitingHint: spec.waitingHint,
        freeText: spec.freeText,
        delivered: false,
        text: spec.text,
        retryText: spec.retryText,
        retried: false,
        done: false,
        preempt: () => {
          const value = item.done ? undefined : spec.preempt?.();
          if (value === undefined) return false;
          finish();
          resolve(value);
          return true;
        },
        answer: (reply) => {
          if (item.done) return true;
          const value = spec.parse(reply);
          if (value === undefined) return false;
          finish();
          resolve(value);
          return true;
        },
        expire: (why) => {
          if (item.done) return;
          finish();
          if (why === 'timeout' || why === 'cancelled') this.expiredInteractions.set(uid, Date.now());
          const value = spec.onExpire(why);
          if (value instanceof Error) reject(value); else resolve(value);
        },
      };
      const onAbort = (): void => item.expire('cancelled');
      if (this.stopping) { item.expire('stopped'); return; }
      if (signals.some((s) => s.aborted)) { item.expire('cancelled'); return; }
      for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
      const queue = this.interactions.get(uid);
      if (queue) { queue.push(item); return; }
      this.interactions.set(uid, [item]);
      this.showInteraction(uid, item);
    });
  }

  /** Send the head interaction. Control priority: never held back by the intermediate/activity
   *  caps, and it does not eat into the final reserve. */
  private showInteraction(uid: string, item: PendingInteraction): void {
    if (item.preempt()) return;
    let itemIds: string[] = [];
    this.ilink.sendText(uid, item.text, {
      priority: 'control',
      onEnqueued: (items) => { itemIds = items.map((queued) => queued.itemId); },
    }).then(
      () => this.armWhenDelivered(uid, item, itemIds),
      (err) => {
        // A finalization error means it was delivered; only local bookkeeping failed.
        if (isDeliveryFinalizationError(err)) { this.armWhenDelivered(uid, item, []); return; }
        log.error('[interaction] 无法发送提问/审批消息:', err);
        item.expire('unsent');
      },
    );
  }

  /**
   * The reply clock starts only once the prompt really left the outbox: a prompt queued behind
   * an exhausted window or a rate-limit backoff is invisible to the user, so it must not time
   * out. Until then poll the outbox (it drains on the next inbound, e.g. 继续, or when a backoff
   * ends); cancel, shutdown and the adapter signal still settle it meanwhile.
   */
  private armWhenDelivered(uid: string, item: PendingInteraction, itemIds: string[]): void {
    if (item.done) return;
    const status = itemIds.length > 0 ? this.deliveryStatus(uid) : undefined;
    if (status?.pending.some((queued) => itemIds.includes(queued.itemId))) {
      item.timer = setTimeout(() => this.armWhenDelivered(uid, item, itemIds), PROMPT_DELIVERY_POLL_MS);
      return;
    }
    if (status?.failed?.some((failed) => itemIds.includes(failed.itemId))) {
      log.error('[interaction] 提问/审批消息被拒收，按未发送处理');
      item.expire('unsent');
      return;
    }
    item.delivered = true;
    item.timer = setTimeout(() => item.expire('timeout'), INTERACTION_TIMEOUT_MS);
  }

  private dropInteraction(uid: string, item: PendingInteraction): void {
    const queue = this.interactions.get(uid);
    const index = queue?.indexOf(item) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    if (queue.length === 0) this.interactions.delete(uid);
    else if (index === 0 && !this.stopping) this.showInteraction(uid, queue[0]);
  }

  /**
   * Route a message to the head interaction when it is an answer to it. True when consumed.
   * Everything else goes through normal routing, so no message is swallowed:
   * - nothing is an answer before the prompt actually reached WeChat (the user hasn't seen it);
   * - `@<another tool> …` is addressed to that tool; `@<asking tool> 2` answers with "2";
   * - an approval only takes its listed choices — a wrong number gets one re-prompt, then the
   *   request is rejected; ordinary text is not an answer (if it targets the waiting tool, the
   *   busy notice says the tool is waiting and the message was not executed);
   * - an AskUser question takes any text, as free-form answers are allowed.
   */
  private async answerInteraction(uid: string, text: string): Promise<boolean> {
    const head = this.interactions.get(uid)?.[0];
    if (!head?.delivered) return false;
    let reply = text;
    const at = text.match(/^@([\w-]+)(?:[\s：:]+([\s\S]*))?$/);
    const mentioned = at ? this.resolveToolName(at[1]) : undefined;
    if (mentioned) {
      if (mentioned !== head.toolName) return false;
      reply = (at![2] || '').trim();
      if (!reply) return false;
    }
    if (head.answer(reply)) return true;
    if (head.freeText || !BARE_ANSWER.test(reply)) return false;
    if (head.retryText && !head.retried) {
      head.retried = true;
      await this.ilink.sendText(uid, head.retryText, { priority: 'control' });
    } else {
      head.expire('invalid');
    }
    return true;
  }

  /** The "<tool> 在忙" reply, saying so explicitly when the tool is waiting on the user. */
  private busyText(uid: string, toolName: string): string {
    const waiting = this.interactions.get(uid)?.find((item) => item.toolName === toolName);
    const displayName = this.registry.get(toolName)?.displayName ?? toolName;
    if (!waiting) return `${toolName} 在忙`;
    if (!waiting.delivered) {
      return `${displayName} 有一条提问/审批还没送达微信（回复「继续」接收）。\n这条消息未执行，处理完后请重发。`;
    }
    return `${displayName} 正在等你${waiting.waitingHint}。\n这条消息未执行，处理完后请重发。`;
  }

  /**
   * A bare "1"/"2"/"3" with nothing waiting is almost certainly a late answer — to a prompt that
   * timed out or was cancelled, or one a restart killed (the CLI that asked is gone, so the
   * question is not persisted; its task shows up as recovery-required). Say so instead of
   * sending "1" to an Agent as a new prompt.
   */
  private staleAnswerHint(uid: string, text: string): string | undefined {
    if (!BARE_ANSWER.test(text)) return undefined;
    const now = Date.now();
    const expiredAt = this.expiredInteractions.get(uid);
    if (expiredAt !== undefined && now - expiredAt < STALE_ANSWER_WINDOW_MS) {
      this.expiredInteractions.delete(uid);
      return '没有正在等待回复的提问或审批：上一个已超时或已取消（审批按拒绝处理）。\n如需继续，请重新发送完整指令。';
    }
    const interrupted = this.tasks.list({ userId: uid, phases: ['recovery-required'] }).some((task) =>
      task.recovery?.reason === 'agent-interrupted'
      && task.recovery.detectedByBootId === this.bootId
      && now - task.recovery.at < STALE_ANSWER_WINDOW_MS);
    if (!interrupted) return undefined;
    return '没有正在等待回复的提问或审批：桥接服务刚重启，重启前的提问/审批已随 CLI 进程结束而失效（/tasks 查看中断的任务）。\n如需继续，请重新发送完整指令。';
  }

  private async askUserViaWeChat(
    uid: string,
    toolName: string,
    req: AskUserRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const adapter = this.registry.get(toolName);
    const displayName = adapter?.displayName ?? toolName;

    // Format questions for WeChat display
    const lines: string[] = [`${displayName} 需要你的回答:`];
    for (const q of req.questions) {
      lines.push('');
      lines.push(`❓ ${q.question}`);
      q.options.forEach((opt, i) => {
        lines.push(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
      });
      if (q.multiSelect) lines.push('  (可多选，用逗号分隔数字)');
    }
    lines.push(`— ${displayName} | 等待回复`);

    // Free-form answers are valid, so there is no retry; timeout / cancel throw (the adapter denies).
    const reply = await this.interact<string>(uid, {
      toolName,
      waitingHint: '回答提问（直接回复即可）',
      freeText: true,
      text: lines.join('\n'),
      parse: (text) => text,
      onExpire: (why) => new Error(why === 'timeout' ? '回复超时' : why === 'cancelled' ? '已取消' : '未回复'),
      signals: [signal],
    });

    // Parse reply → map to question answers
    const answers: Record<string, string> = {};
    const replyParts = reply.split(/[,，]/);

    for (let i = 0; i < req.questions.length; i++) {
      const q = req.questions[i];
      const userInput = (replyParts[i] || reply).trim();

      // Try to match by number
      const num = parseInt(userInput);
      if (num >= 1 && num <= q.options.length) {
        answers[q.question] = q.options[num - 1].label;
      } else {
        // Try to match by label
        const match = q.options.find(o => o.label.toLowerCase() === userInput.toLowerCase());
        answers[q.question] = match ? match.label : userInput;
      }
    }

    log.debug(`[askUser] answers: ${JSON.stringify(answers)}`);
    return answers;
  }

  /**
   * Tool approval in `safe` mode: 1 = allow once, 2 = allow this kind of operation for the rest
   * of the session, 3 = reject. Resolves to the chosen option id; null (= reject) on timeout,
   * cancel, shutdown or a second invalid reply.
   *
   * "2" is a bridge-side grant, never the agent's allow_always: Claude persists that one into
   * the project's .claude/settings.local.json, and every turn is a fresh CLI process anyway. We
   * remember (user, tool, rule key) in memory and answer allow_once for it from then on.
   */
  private requestPermissionViaWeChat(
    uid: string,
    toolName: string,
    req: PermissionRequest,
    signals: Array<AbortSignal | undefined>,
  ): Promise<string | null> {
    const displayName = this.registry.get(toolName)?.displayName ?? toolName;
    const byKind = (kind: string) => req.options.find((option) => option.kind === kind);
    const allow = (byKind('allow_once') ?? byKind('allow_always'))?.id;
    const grantKey = `${uid}:${toolName}`;
    const { key: rule, label } = permissionRule(req);
    const title = req.title.length > 300 ? `${req.title.slice(0, 300)}…` : req.title;
    const granted = (): string | undefined => {
      if (!allow || !this.sessionGrants.get(grantKey)?.has(rule)) return undefined;
      log.info(`[approval] ${toolName} ${title} → ${allow} (本会话已允许 ${rule})`);
      return allow;
    };
    const auto = granted();
    if (auto) return Promise.resolve(auto);

    const choices = new Map<string, string | null>();
    const lines: string[] = [];
    const once = byKind('allow_once');
    if (once) { choices.set('1', once.id); lines.push('1. 允许一次'); }
    if (allow) { choices.set('2', allow); lines.push(`2. 本会话自动允许所有「${label}」`); }
    choices.set('3', (byKind('reject_once') ?? byKind('reject_always'))?.id ?? null);
    lines.push('3. 拒绝');
    return this.interact<string | null>(uid, {
      toolName,
      waitingHint: `审批（回复 ${[...choices.keys()].join('/')}）`,
      freeText: false,
      text: `${displayName} 请求权限：${title}\n${lines.join('\n')}\n— 回复数字；5 分钟无回复自动拒绝`,
      retryText: `请回复 ${[...choices.keys()].join('/')}（${displayName} 请求权限：${title}）\n再次无效将自动拒绝`,
      // A grant made while this request sat in the queue answers it without a message.
      preempt: granted,
      parse: (reply) => {
        const key = reply.trim();
        const choice = choices.get(key);
        if (choice === undefined) return undefined;
        if (key === '2') {
          const rules = this.sessionGrants.get(grantKey) ?? new Set<string>();
          this.sessionGrants.set(grantKey, rules.add(rule));
        }
        log.info(`[approval] ${toolName} ${title} → ${choice ?? 'reject'}${key === '2' ? ` (本会话允许 ${rule})` : ''}`);
        return choice;
      },
      onExpire: (why) => {
        log.info(`[approval] ${toolName} ${title} → reject (${why})`);
        if (why === 'invalid') {
          this.ilink.sendText(uid, `未识别的回复，已拒绝：${title}`, { priority: 'control' })
            .catch((err) => log.error('[approval] 无法发送拒绝提示:', err));
        }
        return null;
      },
      signals,
    });
  }

  /**
   * Streaming yields to approval prompts: nothing streams while a prompt waits for the user, and
   * for a tool that asks in WeChat (`capabilities.approvals`) in `safe` mode the last free item
   * of a delivery window is kept for a prompt instead of being spent on progress text. Held-back text is not lost: the final answer
   * is then sent in full rather than as a footer. Router-side only; the outbox and quota rules
   * (src/ilink) and the durable task lifecycle are untouched.
   */
  private holdStreamForPrompt(uid: string, mode: string | undefined, asksApprovals: boolean): boolean {
    if (this.interactions.has(uid)) return true;
    if (mode !== 'safe' || !asksApprovals) return false;
    const status = this.deliveryStatus(uid) as (DeliveryStatusView & { quota: { remainingItems?: number } }) | undefined;
    const remaining = status?.quota.remainingItems;
    return typeof remaining === 'number' && remaining - status!.pending.length <= 1;
  }

  /** "本会话" ends with /new, /clear, /resume <…>, a workDir change or a restart (grants are memory-only). */
  private clearSessionGrants(uid: string): void {
    for (const key of [...this.sessionGrants.keys()]) {
      if (key.startsWith(`${uid}:`)) this.sessionGrants.delete(key);
    }
  }

  private async exec(
    uid: string,
    toolName: string,
    prompt: string,
    media?: DownloadedMedia[],
    taskGeneration?: number,
    run?: TaskRun,
  ): Promise<void> {
    const adapter = this.registry.get(toolName);
    if (!adapter) return;

    const abort = new AbortController();
    this.active.set(`${uid}:${toolName}`, { abort, tool: toolName });
    const stopTyping = await this.ilink.startTyping(uid);
    const start = Date.now();
    const settings = this.sessions.get(uid);
    const msgMode = this.normalizeMsgMode(settings.msgMode);
    taskGeneration ??= (this.ilink as ILinkClient & {
      getDeliveryStatus?: (userId: string) => { quota: { generation: number } };
    }).getDeliveryStatus?.call(this.ilink, uid)?.quota.generation;
    run ??= this.ephemeralRun(uid, taskGeneration);

    // Track if we've streamed text (to avoid duplicate with final result)
    let hasStreamedText = false;
    let intermediateSendFailed = false;
    /** Streamed text was held back (see holdStreamForPrompt): the final answer then carries it all. */
    let streamHeldBack = false;

    // Serialize intermediate sends in-order to avoid burst/concurrency.
    let sendQueue: Promise<unknown> = Promise.resolve();
    const enqueueIntermediateSend = (text: string, priority: 'intermediate' | 'activity' = 'intermediate'): void => {
      if (!text.trim()) return;
      sendQueue = sendQueue
        .then(() => {
          if (this.holdStreamForPrompt(uid, settings.mode, Boolean(adapter.capabilities.approvals))) {
            if (priority === 'intermediate') streamHeldBack = true;
            return;
          }
          return this.ilink.sendText(uid, text, {
            streamType: 'intermediate',
            priority,
            generation: taskGeneration,
          });
        })
        .catch((err) => {
          intermediateSendFailed = true;
          log.error(`[${toolName}] 发送中间消息失败:`, err);
        });
    };

    // Keep text/thinking and tool activity as two independent streams.
    // This allows tool blocks to be sent as standalone messages while preserving order.
    const textLines: string[] = [];
    // Per-request: carries a marker head that straddles two streamed blocks.
    const stripSendFileMarkers = createSendFileMarkerStripper();
    const activityLines: string[] = [];
    const finalActivityLines: string[] = [];
    let textFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushTextBatch = (): void => {
      if (textFlushTimer) {
        clearTimeout(textFlushTimer);
        textFlushTimer = null;
      }
      if (textLines.length === 0) return;
      const payload = textLines.join('\n\n');
      textLines.length = 0;
      enqueueIntermediateSend(payload);
    };

    const flushActivityBatch = (): void => {
      if (msgMode !== 'verbose') {
        activityLines.length = 0;
        return;
      }
      if (activityLines.length === 0) return;
      const payload = ['Activity', ...activityLines].join('\n');
      activityLines.length = 0;
      enqueueIntermediateSend(payload, 'activity');
    };

    const scheduleTextFlush = (): void => {
      if (textFlushTimer) clearTimeout(textFlushTimer);
      textFlushTimer = setTimeout(() => {
        textFlushTimer = null;
        flushTextBatch();
      }, 2500);
    };

    // Streaming intermediate messages (for verbose/normal mode)
    const onIntermediate = msgMode !== 'compact' ? (msg: import('../adapters/base.js').IntermediateMessage) => {
      const content = typeof msg.content === 'string' ? msg.content.trim() : '';
      switch (msg.type) {
        case 'tool_use':
          if (msgMode === 'normal') {
            finalActivityLines.push(content || `- ${msg.toolName || 'Tool'}`);
          } else if (msgMode === 'verbose') {
            // Boundary: flush pending text first, then append activity.
            flushTextBatch();
            if (content) {
              activityLines.push(content);
            } else {
              activityLines.push(`- ${msg.toolName || 'Tool'}`);
            }
          }
          break;
        case 'thinking':
          // thinking 显示只由 showThoughts 控制，与 msgMode 无关
          if (settings.showThoughts && content) {
            // Boundary: flush pending activity first, then append text.
            flushActivityBatch();
            textLines.push(`💭 ${content}`);
            scheduleTextFlush();
          }
          break;
        case 'text': {
          // Markers must not reach WeChat: the final text gets them stripped by
          // buildOutputs, but streamed chunks never pass through it.
          const visible = content ? stripSendFileMarkers(content) : '';
          if (visible) {
            hasStreamedText = true;
            // Boundary: flush pending activity first, then append text.
            flushActivityBatch();
            textLines.push(visible);
            scheduleTextFlush();
          }
          break;
        }
        case 'tool_result':
          if (msgMode === 'verbose' && content) {
            flushTextBatch();
            activityLines.push(content);
          }
          break;
      }
    } : undefined;

    try {
      // Durable boundary: the adapter is only invoked after the task says `running`.
      run.store.markRunning(run.taskId, this.bootId, toolName);
      let outcome: DeliveryOutcome;
      try {
        const { result, notice } = await this.runOnce(toolName, uid, prompt, abort.signal, media, onIntermediate);

        // Ensure all buffered intermediate content is emitted before final response.
        flushTextBatch();
        flushActivityBatch();
        await sendQueue;

        if (abort.signal.aborted) { this.settleAborted(run); return; }

        if (result.sessionId && adapter.capabilities.sessionResume) {
          this.sessions.setSession(uid, toolName, result.sessionId);
        }

        // Store for >> relay; auto-switch defaultTool to last used tool
        this.lastResponse.set(uid, { tool: adapter.displayName, text: result.text.replace(sendFileMarkerRegex(), '').trim() });
        this.sessions.update(uid, { defaultTool: toolName });

        outcome = {
          kind: 'exec',
          toolName,
          displayName: adapter.displayName,
          msgMode,
          showThoughts: Boolean(settings.showThoughts),
          text: result.text,
          ...(result.thinking ? { thinking: result.thinking } : {}),
          error: result.error,
          duration: result.duration || (Date.now() - start),
          notice,
          hasStreamedText: hasStreamedText && !streamHeldBack,
          intermediateSendFailed,
          finalActivityLines: [...finalActivityLines],
          generation: taskGeneration,
        };
      } catch (err: unknown) {
        if (abort.signal.aborted) { this.settleAborted(run); return; }
        log.error(`[${toolName}] 失败:`, err);
        outcome = {
          kind: 'texts',
          texts: [{ text: `失败: ${(err as Error).message}`, priority: 'final' }],
          generation: taskGeneration,
        };
      }
      // From here on the outcome is durable: replay or restart only resumes delivery.
      const deliveryRun = this.commitOutcome(run, outcome);
      try {
        await this.deliverTask(uid, deliveryRun);
      } catch (err) {
        log.error(`[${toolName}] 交付暂停，等待下次入站或重启后继续:`, err);
      }
    } finally {
      // Defensive cleanup for pending timer when task exits early.
      if (textFlushTimer) clearTimeout(textFlushTimer);
      stopTyping();
      this.active.delete(`${uid}:${toolName}`);
    }
  }
}

/**
 * Scope of a "2 = 本会话自动允许" grant. Commands are granted per program (the first word of the
 * command: allowing `npm test` also allows `npm run build`, never `rm -rf`). Other calls are
 * granted per tool kind (edit / read / fetch …), else per the tool name leading the title
 * ("Skill: x" → "Skill"). The prompt spells the scope out.
 */
function permissionRule(req: PermissionRequest): { key: string; label: string } {
  if (req.kind === 'execute') {
    const quoted = /`([^`]+)`/.exec(req.title)?.[1];
    const command = (quoted ?? req.title.replace(/^[^:：`]*[:：]\s*/, ''))
      .trim().replace(/^(run|execute|运行|执行)\s+/i, '');
    const program = command.split(/\s+/)[0];
    if (program) return { key: `execute:${program}`, label: `${program} 命令` };
  }
  if (req.kind) return { key: req.kind, label: `${req.kind} 类操作` };
  const head = req.title.split(/[:：]/)[0].trim() || req.title.trim() || 'tool';
  return { key: head, label: `${head} 操作` };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
