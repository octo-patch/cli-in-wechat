import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { log } from '../utils/logger.js';
import { ILinkClient, isDeliveryFinalizationError } from '../ilink/client.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { SessionManager } from './session.js';
import { formatResponse } from './formatter.js';
import type { WeixinMessage } from '../ilink/types.js';
import type { BridgeConfig } from '../config.js';
import { DEFAULT_SETTINGS, type AskUserRequest, type MsgMode } from '../adapters/base.js';
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
interface PendingQuestion { resolve: (answer: string) => void; timeout: ReturnType<typeof setTimeout>; toolName: string }

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

const TOOL_ALIASES: Record<string, string> = {
  claude: 'claude', cc: 'claude',
  codex: 'codex', cx: 'codex',
  gemini: 'gemini', gm: 'gemini',
  kimi: 'kimi', km: 'kimi',
  opencode: 'opencode', oc: 'opencode',
};

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
  private pendingQuestions = new Map<string, PendingQuestion>();
  private _lastSessionList: Array<{ id: string; date: string; summary: string }> | null = null;
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
    for (const pending of this.pendingQuestions.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingQuestions.clear();
  }

  private resolveToolFromRefText(refText: string): string | undefined {
    // Parse tool from footer: "— DisplayName | ..."
    const footerMatch = refText.match(/— ([^\|\n]+?)(?:\s*\||\s*$)/m);
    if (footerMatch) return this.registry.getNameByDisplayName(footerMatch[1].trim());
    return undefined;
  }

  // ── getCli: determine terminal from @mention → ref footer → current session ──
  private getCli(uid: string, text: string, refText?: string): string {
    const atMatch = text.match(/^@(\w+)/);
    if (atMatch) {
      const resolved = TOOL_ALIASES[atMatch[1].toLowerCase()];
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

    // ── Parse: @tool1>tool2 chain, @tool single, >> relay, plain text ──

    // Pattern: @tool1>tool2 prompt  →  chain: tool1 processes, output feeds tool2
    const chainMatch = trimmed.match(/^@(\w+)>(\w+)\s+([\s\S]+)$/);
    if (chainMatch) {
      const t1 = TOOL_ALIASES[chainMatch[1].toLowerCase()];
      const t2 = TOOL_ALIASES[chainMatch[2].toLowerCase()];
      const prompt = chainMatch[3].trim();
      if (t1 && t2 && this.registry.isAvailable(t1) && this.registry.isAvailable(t2)) {
        const busy = [t1, t2].find(t => this.active.has(`${uid}:${t}`));
        if (busy) { await this.ilink.sendText(uid, `${busy} 在忙`); return; }
        await this.chain(uid, t1, t2, prompt + mediaContext, media, taskGeneration, run);
        return;
      }
    }

    // Pattern: >> prompt  →  relay: prepend last response as context
    if (trimmed.startsWith('>>')) {
      const rest = trimmed.substring(2).trim();
      const prev = this.lastResponse.get(uid);
      if (!prev) {
        await this.ilink.sendText(uid, '没有上一条回复可接力');
        return;
      }
      const atRelayMatch = rest.match(/^@(\w+)[\s：:]\s*([\s\S]+)$/);
      const prompt = atRelayMatch ? atRelayMatch[2].trim() : rest;
      const toolName = this.getCli(uid, rest, refText);
      this.sessions.update(uid, { defaultTool: toolName });
      if (this.active.has(`${uid}:${toolName}`)) { await this.ilink.sendText(uid, `${toolName} 在忙`); return; }
      const fullPrompt = `以下是 ${prev.tool} 的输出:\n\n${prev.text}\n\n---\n\n${prompt}${mediaContext}`;
      await this.exec(uid, toolName, fullPrompt, media, taskGeneration, run);
      return;
    }

    // ── @mention 合法性校验 ──
    const atMatch = trimmed.match(/^@(\w+)(?:[\s：:]\s*([\s\S]+))?$/);
    if (atMatch && !TOOL_ALIASES[atMatch[1].toLowerCase()]) {
      await this.ilink.sendText(uid, `未知终端: @${atMatch[1]}\n可用: ${Object.keys(TOOL_ALIASES).join(', ')}`);
      return;
    }

    const toolName = this.getCli(uid, trimmed, refText);

    // ── If a tool is waiting for AskUser reply, resolve it before normal execution ──
    const pendingKey = `${uid}:${toolName}`;
    const pending = this.pendingQuestions.get(pendingKey);
    if (pending && trimmed) {
      clearTimeout(pending.timeout);
      this.pendingQuestions.delete(pendingKey);
      pending.resolve(trimmed);
      return;
    }

    // ── getCli 决定终端，立即切换 defaultTool ──
    this.sessions.update(uid, { defaultTool: toolName });

    if (!this.registry.isAvailable(toolName)) {
      await this.ilink.sendText(uid, `"${toolName}" 不可用\n可用: ${this.registry.getAvailableNames().join(', ')}`);
      return;
    }

    // @tool 无 prompt → 仅切换，确认后返回
    if (atMatch && !atMatch[2]) {
      await this.ilink.sendText(uid, `已切换到 ${toolName}`);
      return;
    }

    if (this.active.has(`${uid}:${toolName}`)) { await this.ilink.sendText(uid, `${toolName} 在忙`); return; }

    const prompt = atMatch ? atMatch[2].trim() : trimmed;
    const combined = [prompt, refText].filter(Boolean).join('\n\n') + mediaContext;
    await this.exec(uid, toolName, combined, media, taskGeneration, run);
  }

  // ─── /command → ALL are commands, never pass through ────

  private async handleSlash(uid: string, text: string, taskGeneration?: number, run?: TaskRun): Promise<boolean> {
    const parts = text.substring(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim();
    const settings = this.sessions.get(uid);
    const reply = (msg: string) => this.ilink.sendText(uid, msg);

    switch (cmd) {
      // ═══════════════════════════════════════════
      // 通用
      // ═══════════════════════════════════════════

      case 'help': case 'h':
        await reply([
          '=== cli-in-wechat 命令 ===',
          '',
          '— 设置 —',
          '/status  查看所有配置',
          '/models  查看可用模型',
          '/model <名>  切模型',
          '/mode <auto|safe|plan>  权限',
          '/effort <low|med|high|xhigh|max>  深度',
          '/turns <数>  最大轮次',
          '/budget <$>  预算(off=无限)',
          '/dir <路径>  工作目录',
          '/system <词>  追加系统提示',
          '/tools <列表>  允许工具',
          '/notool <列表>  禁用工具',
          '/verbose  已弃用(Kimi 新版无 --verbose)',
          '/bare  跳过配置加载',
          '/adddir <路径>  额外目录',
          '/name <名>  会话命名',
          '/sandbox <ro|write|full>  沙箱',
          '/search  web搜索(Codex)',
          '/ephemeral  临时模式(Codex)',
          '/profile <名>  配置(Codex)',
          '/approval <模式>  审批(Gemini)',
          '/include <目录>  上下文(Gemini)',
          '/ext <名>  扩展(Gemini)',
          '/thinking  已弃用(Kimi 新版无 --thinking)',
          '/thoughts  显示AI思考内容',
          '/msgmode <verbose|normal|compact|default>  消息详细度',
          '',
          '— 操作 —',
          '/diff  查看git差异',
          '/commit  创建git提交',
          '/review  代码审查',
          '/plan [描述]  规划模式/制定计划',
          '/init  创建项目配置文件',
          '/files  列出目录结构',
          '/compact  压缩上下文(清session)',
          '/stats  使用统计',
          '/send <文件路径>  发送文件到微信',
          '',
          '— 会话 —',
          '/new  新会话',
          '/clear  清除所有',
          '/cancel  取消任务',
          '/tasks [ack]  查看/确认中断的任务',
          '/fork  分支当前会话',
          '/resume  查看保存的会话',
          '',
          '— 快捷 —',
          '/yolo  auto+effort max',
          '/fast  effort low',
          '/reset  重置所有设置',
          '/cc /cx /gm /km /oc  切工具',
          '',
          '— 发消息 —',
          '@claude/@codex/@gemini/@kimi/@opencode  指定工具',
          '>>  接力(传上条结果)',
          '@tool1>tool2  链式调用',
        ].join('\n'));
        return true;

      case 'status': case 'st': {
        const def = settings.defaultTool || this.config.defaultTool;
        const currentMsgMode = this.normalizeMsgMode(settings.msgMode);
        const defaultMsgMode = this.getDefaultMsgMode();
        const sids = Object.entries(settings.sessionIds).map(([k, v]) => `${k}:${String(v).substring(0, 8)}`).join(' ') || '无';
        const lines = [
          `工具: ${def}`,
          `模式: ${settings.mode}`,
          `effort: ${settings.effort}`,
          `model: ${settings.model || '默认'}`,
          `turns: ${settings.maxTurns}`,
          `budget: ${settings.maxBudget > 0 ? '$' + settings.maxBudget : '无限'}`,
          `sandbox: ${settings.sandbox || '无'}`,
          `search: ${settings.search ? 'ON' : 'OFF'}`,
          `msgMode: ${currentMsgMode} (默认: ${defaultMsgMode})`,
          `thoughts: ${settings.showThoughts ? 'ON' : 'OFF'}`,
          `cliVerbose: ${settings.verbose ? 'ON' : 'OFF'} (Kimi)`,
          `system: ${settings.systemPrompt ? settings.systemPrompt.substring(0, 40) + '...' : '无'}`,
          `dir: ${settings.workDir || this.config.workDir}`,
          `会话: ${sids}`,
          `可用: ${this.registry.getAvailableNames().join(', ')}`,
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
        await reply(lines.join('\n'));
        return true;
      }

      case 'models': {
        try {
          const stdout = execSync('opencode models', {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          const models = stdout.trim().split(/\r?\n/).filter(Boolean);
          await reply(models.length > 0 ? `可用模型 (${models.length}个):\n${models.join('\n')}` : '没有可用的模型');
        } catch (err) {
          await reply(`获取模型列表失败: ${(err as Error).message}`);
        }
        return true;
      }

      case 'new': case 'n':
        this.sessions.clearSession(uid);
        await reply('新会话');
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

      case 'model': case 'm':
        const model = this.normalizeModelArg(arg);
        if (!model) {
          this.sessions.update(uid, { model: '' });
          await reply('model → 默认');
        } else {
          this.sessions.update(uid, { model });
          await reply(`model → ${model}`);
        }
        return true;

      case 'mode': {
        const modes: Record<string, string> = { auto: 'auto', safe: 'safe', plan: 'plan' };
        const v = modes[arg.toLowerCase()];
        if (!v) { await reply('/mode <auto|safe|plan>\nauto=最高权限 safe=需确认 plan=只读'); return true; }
        this.sessions.update(uid, { mode: v as any });
        const desc: Record<string, string> = {
          auto: 'AUTO\nClaude: --dangerously-skip-permissions\nCodex: --yolo\nGemini: --approval-mode yolo\nKimi: -p (自带auto)',
          safe: 'SAFE\nClaude: 默认权限\nCodex: --sandbox workspace-write\nGemini: --approval-mode default\nKimi: -p 恒auto (/mode 对Kimi无效)',
          plan: 'PLAN\nClaude: --permission-mode plan\nCodex: --sandbox read-only\nGemini: --approval-mode plan\nKimi: -p 不支持plan (恒auto)',
        };
        await reply(desc[v]);
        return true;
      }

      case 'dir': case 'cd':
        if (!arg) { await reply(`当前: ${settings.workDir || this.config.workDir}`); return true; }
        this.sessions.update(uid, { workDir: arg });
        await reply(`dir → ${arg}`);
        return true;

      case 'system': case 'sys':
        if (!arg || arg === 'clear' || arg === 'reset') {
          this.sessions.update(uid, { systemPrompt: '' });
          await reply('system prompt → 清除');
        } else {
          this.sessions.update(uid, { systemPrompt: arg });
          await reply(`system prompt → ${arg.substring(0, 60)}...`);
        }
        return true;

      // ═══════════════════════════════════════════
      // Claude Code
      // ═══════════════════════════════════════════

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

      case 'turns': case 't': {
        const n = parseInt(arg);
        if (!n || n < 1) { await reply(`当前: ${settings.maxTurns}\n/turns <数字>`); return true; }
        this.sessions.update(uid, { maxTurns: n });
        await reply(`turns → ${n}`);
        return true;
      }

      case 'budget': case 'b':
        if (!arg || arg === 'off' || arg === '0') {
          this.sessions.update(uid, { maxBudget: 0 });
          await reply('budget → 无限');
        } else {
          const v = parseFloat(arg);
          if (isNaN(v)) { await reply('/budget <美元> 或 /budget off'); return true; }
          this.sessions.update(uid, { maxBudget: v });
          await reply(`budget → $${v}`);
        }
        return true;

      case 'tools':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { allowedTools: '' });
          await reply('allowedTools → 全部');
        } else {
          this.sessions.update(uid, { allowedTools: arg });
          await reply(`allowedTools → ${arg}`);
        }
        return true;

      case 'notool':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { disallowedTools: '' });
          await reply('disallowedTools → 无');
        } else {
          this.sessions.update(uid, { disallowedTools: arg });
          await reply(`disallowedTools → ${arg}`);
        }
        return true;

      case 'verbose': case 'v': {
        // Capture the new value first: update() mutates the live `settings` object,
        // so reading settings.verbose after update() would report the opposite state.
        const v = !settings.verbose;
        this.sessions.update(uid, { verbose: v });
        await reply(`verbose(Kimi CLI) → ${v ? 'ON' : 'OFF'}`);
        return true;
      }

      // ═══════════════════════════════════════════
      // Codex
      // ═══════════════════════════════════════════

      case 'sandbox': case 'sb': {
        const aliases: Record<string, string> = {
          ro: 'read-only', 'read-only': 'read-only', readonly: 'read-only',
          ws: 'workspace-write', 'workspace-write': 'workspace-write', write: 'workspace-write',
          full: 'danger-full-access', 'danger-full-access': 'danger-full-access', danger: 'danger-full-access',
          off: '', reset: '',
        };
        const v = aliases[arg.toLowerCase()];
        if (v === undefined) { await reply(`当前: ${settings.sandbox || '无'}\n/sandbox <read-only|write|full|off>`); return true; }
        this.sessions.update(uid, { sandbox: v });
        await reply(v ? `sandbox → ${v}` : 'sandbox → OFF (yolo)');
        return true;
      }

      case 'search': {
        const v = !settings.search;
        this.sessions.update(uid, { search: v });
        await reply(`search → ${v ? 'ON' : 'OFF'}`);
        return true;
      }

      case 'ephemeral': {
        const v = !settings.ephemeral;
        this.sessions.update(uid, { ephemeral: v });
        await reply(`ephemeral → ${v ? 'ON' : 'OFF'}`);
        return true;
      }

      case 'profile':
        if (!arg) { await reply(`当前: ${settings.profile || '无'}\n/profile <名称> 或 /profile reset`); return true; }
        this.sessions.update(uid, { profile: arg === 'reset' ? '' : arg });
        await reply(arg === 'reset' ? 'profile → 默认' : `profile → ${arg}`);
        return true;

      // ═══════════════════════════════════════════
      // Kimi Code
      // ═══════════════════════════════════════════

      case 'thinking': {
        const v = !settings.thinking;
        this.sessions.update(uid, { thinking: v });
        await reply(`thinking → ${v ? 'ON (深度思考)' : 'OFF'}`);
        return true;
      }

      case 'thoughts': {
        const newValue = !settings.showThoughts;
        this.sessions.update(uid, { showThoughts: newValue });
        await reply(`thoughts → ${newValue ? '已开启 (将显示AI思考)' : '已关闭'}`);
        return true;
      }

      case 'msgmode': {
        const defaultMode = this.getDefaultMsgMode();
        const currentMode = this.normalizeMsgMode(settings.msgMode);
        const highRiskNow = currentMode === 'verbose' && !!settings.showThoughts;
        const warning = '⚠️ 警告: 高频交互任务（如浏览器操作）不建议同时开启 /thoughts + /msgmode verbose，可能触发 iLink 限流，通常约 2-3 分钟恢复。';
        const modes: Record<string, MsgMode> = {
          verbose: 'verbose',
          detailed: 'verbose',
          normal: 'normal',
          compact: 'compact',
          simple: 'compact',
        };
        if (!arg) {
          await reply([
            `当前: ${currentMode}`,
            `默认: ${defaultMode}`,
            '/msgmode <verbose|normal|compact|default>',
            '',
            'verbose - 流式显示文本 + Activity(含摘要)',
            'normal  - 流式显示文本，Activity仅在最终结果展示',
            'compact - 仅显示最终结果',
            '',
            '(思考内容由 /thoughts 控制)',
            '',
            warning,
            `当前风险: ${highRiskNow ? '高' : '正常'}`,
          ].join('\n'));
          return true;
        }

        const lower = arg.toLowerCase();
        if (lower === 'default' || lower === 'reset') {
          this.sessions.update(uid, { msgMode: defaultMode });
          const risk = defaultMode === 'verbose' && !!settings.showThoughts ? '高' : '正常';
          await reply(`msgmode: ${currentMode} → ${defaultMode}\n当前: ${defaultMode} | 默认: ${defaultMode}\n当前风险: ${risk}\n\n${warning}`);
          return true;
        }

        const v = modes[lower];
        if (!v) {
          await reply(`无效 msgmode: ${arg}\n当前: ${currentMode}\n默认: ${defaultMode}\n/msgmode <verbose|normal|compact|default>`);
          return true;
        }

        this.sessions.update(uid, { msgMode: v });
        const desc: Record<MsgMode, string> = {
          verbose: '流式显示文本 + Activity(含摘要)',
          normal: '流式显示文本，Activity仅在最终结果展示',
          compact: '仅显示最终结果',
        };
        const highRisk = v === 'verbose' && !!settings.showThoughts;
        await reply([
          `msgmode: ${currentMode} → ${v}`,
          `当前: ${v} | 默认: ${defaultMode}`,
          `当前风险: ${highRisk ? '高' : '正常'}`,
          '',
          desc[v],
          '',
          '(思考内容由 /thoughts 控制)',
          ...(highRisk ? ['', warning] : []),
        ].join('\n'));
        return true;
      }

      // ═══════════════════════════════════════════
      // Gemini
      // ═══════════════════════════════════════════

      case 'approval': {
        const modes: Record<string, string> = { default: 'default', auto_edit: 'auto_edit', yolo: 'yolo', plan: 'plan' };
        const v = modes[arg.toLowerCase()];
        if (!v) { await reply(`当前: ${settings.approvalMode || 'yolo'}\n/approval <default|auto_edit|yolo|plan>`); return true; }
        this.sessions.update(uid, { approvalMode: v });
        await reply(`approval-mode → ${v}`);
        return true;
      }

      case 'include': case 'inc':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { includeDirs: '' });
          await reply('include dirs → 清除');
        } else {
          this.sessions.update(uid, { includeDirs: arg });
          await reply(`include dirs → ${arg}`);
        }
        return true;

      case 'ext': case 'extensions':
        if (!arg || arg === 'reset') {
          this.sessions.update(uid, { extensions: '' });
          await reply('extensions → 默认');
        } else {
          this.sessions.update(uid, { extensions: arg });
          await reply(`extensions → ${arg}`);
        }
        return true;

      // ═══════════════════════════════════════════
      // 快捷组合
      // ═══════════════════════════════════════════

      case 'yolo':
        this.sessions.update(uid, { mode: 'auto', effort: 'max' } as any);
        await reply('YOLO: mode=auto + effort=max');
        return true;

      case 'fast':
        this.sessions.update(uid, { effort: 'low' });
        await reply('effort → low (快速模式)');
        return true;

      case 'reset':
        this.sessions.update(uid, {
          mode: 'auto', effort: 'high', model: '', maxTurns: 100, maxBudget: 0,
          allowedTools: '', disallowedTools: '', verbose: false, sandbox: '',
          search: false, systemPrompt: '', workDir: '', bare: false, addDir: '',
          sessionName: '', ephemeral: false, profile: '', approvalMode: '',
          includeDirs: '', extensions: '', showThoughts: false, msgMode: this.getDefaultMsgMode(),
        } as any);
        await reply('所有设置已重置');
        return true;

      // ═══════════════════════════════════════════
      // Claude 额外
      // ═══════════════════════════════════════════

      case 'bare': {
        const v = !settings.bare;
        this.sessions.update(uid, { bare: v } as any);
        await reply(`bare → ${v ? 'ON (跳过配置加载)' : 'OFF'}`);
        return true;
      }

      case 'adddir': case 'add-dir':
        if (!arg) { await reply(`当前: ${(settings as any).addDir || '无'}\n/adddir <路径>`); return true; }
        this.sessions.update(uid, { addDir: arg } as any);
        await reply(`add-dir → ${arg}`);
        return true;

      case 'name':
        if (!arg) { await reply(`当前: ${(settings as any).sessionName || '无'}\n/name <名称>`); return true; }
        this.sessions.update(uid, { sessionName: arg } as any);
        await reply(`session name → ${arg}`);
        return true;

      // ═══════════════════════════════════════════
      // 操作类 (转化为 prompt 发给当前工具)
      // ═══════════════════════════════════════════

      case 'compact': case 'compress': case 'summarize': {
        // Clear session + start fresh with summary instruction
        this.sessions.clearSession(uid);
        await reply('会话已压缩 (新session, 旧上下文已清除)');
        return true;
      }

      case 'diff': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (this.registry.isAvailable(tool)) {
          await this.exec(uid, tool, arg || 'Show the current git diff of uncommitted changes. Be concise.', undefined, taskGeneration, run);
        }
        return true;
      }

      case 'commit': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (this.registry.isAvailable(tool)) {
          await this.exec(uid, tool, arg || 'Create a git commit for all staged changes with an appropriate commit message.', undefined, taskGeneration, run);
        }
        return true;
      }

      case 'review': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (this.registry.isAvailable(tool)) {
          await this.exec(uid, tool, arg || 'Review the current code changes (git diff) and provide feedback on quality, bugs, and improvements.', undefined, taskGeneration, run);
        }
        return true;
      }

      case 'init': {
        const tool = settings.defaultTool || this.config.defaultTool;
        const file = tool === 'codex' ? 'AGENTS.md' : tool === 'gemini' ? 'GEMINI.md' : 'CLAUDE.md';
        if (this.registry.isAvailable(tool)) {
          await this.exec(uid, tool, arg || `Analyze this project and create a ${file} configuration file with appropriate instructions.`, undefined, taskGeneration, run);
        }
        return true;
      }

      case 'fork': case 'branch': {
        // Fork = clear session ID so next call doesn't --resume
        const tool = settings.defaultTool || this.config.defaultTool;
        this.sessions.clearSession(uid, tool);
        await reply(`已 fork ${tool} 会话 (下次消息开始新分支)`);
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

      case 'files': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (this.registry.isAvailable(tool)) {
          await this.exec(uid, tool, 'List all files in the current working directory. Show the tree structure concisely.', undefined, taskGeneration, run);
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
          const { existsSync } = await import('node:fs');
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

      case 'plan': {
        if (arg) {
          // /plan <description> → send plan request to tool
          const tool = settings.defaultTool || this.config.defaultTool;
          if (this.registry.isAvailable(tool)) {
            await this.exec(uid, tool, `Create a detailed plan for: ${arg}. Only plan, do not execute.`, undefined, taskGeneration, run);
          }
        } else {
          // /plan with no args → switch to plan mode
          this.sessions.update(uid, { mode: 'plan' } as any);
          await reply('PLAN mode ON');
        }
        return true;
      }

      case 'continue': {
        // Alias for /resume
        const sids = Object.entries(settings.sessionIds);
        if (sids.length === 0) {
          await reply('无活跃会话，用 /resume 浏览历史');
        } else {
          const lines = sids.map(([k, v]) => `${k}: ${String(v).substring(0, 12)}...`);
          await reply(`活跃会话:\n${lines.join('\n')}\n\n/resume 浏览所有历史`);
        }
        return true;
      }

      case 'clear': {
        this.sessions.clearSession(uid);
        this.lastResponse.delete(uid);
        await reply('已清除所有会话和历史');
        return true;
      }

      case 'session': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (arg.startsWith('set ')) {
          const id = arg.substring(4).trim();
          this.sessions.setSession(uid, tool, id);
          await reply(`${tool} session → ${id}\n下条消息将 --resume 此会话`);
        } else {
          const sids = Object.entries(settings.sessionIds);
          const lines = sids.length > 0
            ? sids.map(([k, v]) => `${k}: ${v}`).join('\n')
            : '(无活跃会话)';
          await reply(`活跃会话:\n${lines}\n\n/session set <id> 手动设置\n/resume 浏览所有历史会话`);
        }
        return true;
      }

      case 'resume': case 'sessions': {
        const tool = settings.defaultTool || this.config.defaultTool;
        if (arg) {
          // /resume <number> → pick from list, or /resume <uuid> → direct set
          const num = parseInt(arg);
          if (!isNaN(num) && this._lastSessionList) {
            const pick = this._lastSessionList[num - 1];
            if (pick) {
              this.sessions.setSession(uid, tool, pick.id);
              await reply(`已恢复 ${tool} 会话:\n${pick.summary}\n\nID: ${pick.id}`);
            } else {
              await reply(`无效编号，范围 1-${this._lastSessionList.length}`);
            }
          } else {
            // Treat as UUID
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
        this._lastSessionList = list;
        const lines = list.map((s, i) =>
          `${i + 1}. ${s.date} ${s.summary}\n   ${s.id}`
        );
        await reply(`${tool} 历史会话 (最近${list.length}条):\n\n${lines.join('\n\n')}\n\n回复 /resume <编号> 恢复`);
        return true;
      }

      // ═══════════════════════════════════════════
      // 不适用于微信的命令 (给出说明)
      // ═══════════════════════════════════════════

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

      // ═══════════════════════════════════════════
      // 工具切换
      // ═══════════════════════════════════════════

      case 'claude': case 'cc':
        this.sessions.update(uid, { defaultTool: 'claude' }); await reply('→ claude'); return true;
      case 'codex': case 'cx':
        this.sessions.update(uid, { defaultTool: 'codex' }); await reply('→ codex'); return true;
      case 'gemini': case 'gm':
        this.sessions.update(uid, { defaultTool: 'gemini' }); await reply('→ gemini'); return true;
      case 'kimi': case 'km':
        this.sessions.update(uid, { defaultTool: 'kimi' }); await reply('→ kimi'); return true;
      case 'opencode': case 'oc':
        this.sessions.update(uid, { defaultTool: 'opencode' }); await reply('→ opencode'); return true;

      // ═══════════════════════════════════════════
      // 未识别
      // ═══════════════════════════════════════════

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
              try {
                const stat = statSync(join(dayDir, f));
                const id = f.replace('.jsonl', '').replace('rollout-', '').substring(0, 40);
                results.push({
                  id: 'last', // codex uses --last for resume
                  date: `${year}-${month}-${day}`,
                  summary: f.replace('.jsonl', '').substring(0, 50),
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

    if (signal.aborted) return { result: { text: '已取消', error: true }, notice: '' };

    // 追加 SEND_FILE 提示到 prompt
    const sendFileHint = '\n\n[提示: 如果需要发送文件/图片到微信，在响应中包含标记 [SEND_FILE: 文件路径]]';
    const enhancedPrompt = prompt + sendFileHint;

    const result = await adapter.execute(enhancedPrompt, {
      settings, workDir: this.config.workDir, timeout: this.config.cliTimeout, extraArgs, signal,
      askUser: (req) => this.askUserViaWeChat(uid, toolName, req),
      media,
      onIntermediate,
    });

    if (result.sessionExpired && hadSession && !signal.aborted) {
      log.warn(`[${toolName}] 会话已过期，已清除旧会话`);
      this.sessions.clearSession(uid, toolName);
      return { result, notice: '[会话已过期并自动清除，如需重试请重新发送]\n\n' };
    }
    return { result, notice: '' };
  }

  // ─── Execute single tool ──────────────────────────────

  // ─── AskUserQuestion via WeChat ─────────────────────────

  private async askUserViaWeChat(uid: string, toolName: string, req: AskUserRequest): Promise<Record<string, string>> {
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

    await this.ilink.sendText(uid, lines.join('\n'));

    // Wait for user reply (timeout 5 min); key: "${uid}:${toolName}" for concurrent support
    const pendingKey = `${uid}:${toolName}`;
    const reply = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingQuestions.delete(pendingKey);
        reject(new Error('回复超时'));
      }, 300_000);
      this.pendingQuestions.set(pendingKey, { resolve, timeout, toolName });
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

    // Serialize intermediate sends in-order to avoid burst/concurrency.
    let sendQueue: Promise<unknown> = Promise.resolve();
    const enqueueIntermediateSend = (text: string, priority: 'intermediate' | 'activity' = 'intermediate'): void => {
      if (!text.trim()) return;
      sendQueue = sendQueue
        .then(() => this.ilink.sendText(uid, text, {
          streamType: 'intermediate',
          priority,
          generation: taskGeneration,
        }))
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
          hasStreamedText,
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
