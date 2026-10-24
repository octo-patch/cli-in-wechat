import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWrite } from '../config.js';
import type { OutboxPriority } from '../ilink/outbox.js';
import type { DownloadedMedia } from '../utils/media.js';

/**
 * Durable lifecycle of one inbound message (issue #27).
 *
 *   received ──claim──▶ dispatching ──markRunning──▶ running ──recordOutcome──▶ delivery-pending ──▶ completed
 *       │                    │                          │
 *       │                    └──────── restart ─────────┴──▶ recovery-required
 *       └── restart: dispatched again (nothing has happened yet)
 *
 * - `received`: the poll path persisted the inbound before acknowledging it or
 *   committing the poll cursor. Nothing has run; a restart dispatches it.
 * - `dispatching`: a runner (identified by its process `bootId`) owns the task
 *   and is executing Router logic, but no Agent has been invoked.
 * - `running`: an adapter may be executing. Only the owning boot may move it on.
 * - `delivery-pending`: the Agent finished and its outcome is durable here; any
 *   resume only re-drives delivery and never invokes the adapter again.
 * - `recovery-required`: a previous boot was interrupted while it owned the
 *   task, so the system cannot prove what happened. It is never re-run
 *   automatically; the user is told and an operator can inspect it via /tasks.
 *
 * Every transition is a single atomic file write. Phases are never inferred
 * from the Router's in-memory `active` map.
 */
export type TaskPhase =
  | 'received'
  | 'dispatching'
  | 'running'
  | 'delivery-pending'
  | 'completed'
  | 'recovery-required';

export type TaskCompletion =
  | 'delivered'
  | 'no-agent'
  | 'cancelled'
  | 'handler-error'
  | 'operator-acknowledged';

export type RecoveryReason =
  | 'interrupted-during-dispatch'
  | 'agent-interrupted'
  | 'runner-error';

export interface TaskOutput {
  text: string;
  priority: OutboxPriority;
  /** Pause after this output before sending the next one (Normal-mode activity batches). */
  delayAfterMs?: number;
  /** True once the outbox durably holds every chunk of this output. */
  enqueued: boolean;
  itemIds?: string[];
}

export interface TaskFileStep {
  path: string;
  baseName: string;
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
  error?: string;
}

export interface ExecDeliveryOutcome {
  kind: 'exec';
  toolName: string;
  displayName: string;
  msgMode: 'compact' | 'normal' | 'verbose';
  showThoughts: boolean;
  text: string;
  thinking?: string;
  error?: boolean;
  duration: number;
  notice: string;
  hasStreamedText: boolean;
  intermediateSendFailed: boolean;
  finalActivityLines: string[];
  generation?: number;
}

export interface TextsDeliveryOutcome {
  kind: 'texts';
  texts: Array<{ text: string; priority: OutboxPriority }>;
  generation?: number;
}

export type DeliveryOutcome = ExecDeliveryOutcome | TextsDeliveryOutcome;

export interface TaskDiagnostic {
  reason: RecoveryReason;
  at: number;
  /** Phase the task was in when the interruption was detected. */
  phase: TaskPhase;
  /** Boot that owned the task when it was interrupted. */
  ownerBootId?: string;
  detectedByBootId: string;
  tool?: string;
  agentStartedAt?: number;
  detail: string;
}

export interface InboundTask {
  schemaVersion: 1;
  taskId: string;
  accountId: string;
  userId: string;
  messageId: string;
  createdAt: number;
  updatedAt: number;
  phase: TaskPhase;
  inbound: {
    text: string;
    refText: string;
    media?: DownloadedMedia[];
    generation?: number;
  };
  runner?: { bootId: string; claimedAt: number };
  agent?: { tool: string; startedAt: number };
  outcome?: DeliveryOutcome;
  files?: TaskFileStep[];
  outputs?: TaskOutput[];
  completion?: TaskCompletion;
  completionDetail?: string;
  recovery?: TaskDiagnostic;
  history: Array<{ phase: TaskPhase; at: number; bootId?: string }>;
}

export interface HandoffInput {
  accountId: string;
  userId: string;
  messageId: string;
  text: string;
  refText: string;
  media?: DownloadedMedia[];
  generation?: number;
}

export interface TaskStoreOptions {
  now?: () => number;
  /** Completed tasks are kept this long (for diagnostics), then pruned. */
  completedRetentionMs?: number;
  /** Recovery-required tasks are kept this long so an operator can see them. */
  recoveryRetentionMs?: number;
  maxRetainedTasks?: number;
  /**
   * Fault-injection seam for tests: invoked as `before:<transition>` right
   * before a durable write and `after:<transition>` right after it.
   */
  faultHook?: (point: string, task: InboundTask) => void;
}

interface PersistedTasks {
  schemaVersion: 1;
  tasks: InboundTask[];
}

const DEFAULT_COMPLETED_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_RETAINED_TASKS = 500;
const MAX_HISTORY = 20;

export class TaskTransitionError extends Error {
  constructor(taskId: string, from: TaskPhase | undefined, transition: string) {
    super(`task ${taskId} cannot ${transition} from phase ${from ?? 'missing'}`);
    this.name = 'TaskTransitionError';
  }
}

export function taskIdFor(accountId: string, userId: string, messageId: string | number): string {
  return `${accountId}:${userId}:${String(messageId)}`;
}

/**
 * Durable, synchronous task ledger. Every mutator persists before it returns and
 * leaves memory untouched when the write throws, so callers can rely on "the
 * call returned" meaning "the transition is on disk".
 *
 * Without a file path the store is memory-only (used by tests that exercise
 * Router logic directly).
 */
export class InboundTaskStore {
  private tasks = new Map<string, InboundTask>();
  private readonly now: () => number;
  private readonly completedRetentionMs: number;
  private readonly recoveryRetentionMs: number;
  private readonly maxRetainedTasks: number;
  private readonly faultHook?: TaskStoreOptions['faultHook'];

  constructor(private readonly filePath?: string, options: TaskStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.completedRetentionMs = options.completedRetentionMs ?? DEFAULT_COMPLETED_RETENTION_MS;
    this.recoveryRetentionMs = options.recoveryRetentionMs ?? DEFAULT_RECOVERY_RETENTION_MS;
    this.maxRetainedTasks = options.maxRetainedTasks ?? DEFAULT_MAX_RETAINED_TASKS;
    this.faultHook = options.faultHook;
    if (filePath) {
      mkdirSync(dirname(filePath), { recursive: true });
      this.load(filePath);
    }
  }

  get(taskId: string): InboundTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? clone(task) : undefined;
  }

  list(filter?: { userId?: string; phases?: TaskPhase[] }): InboundTask[] {
    return [...this.tasks.values()]
      .filter((task) => (!filter?.userId || task.userId === filter.userId)
        && (!filter?.phases || filter.phases.includes(task.phase)))
      .sort((a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId))
      .map(clone);
  }

  /**
   * Durable handoff: persist ownership of a fresh inbound. Idempotent — a replay
   * of the same inbound returns the existing task with `created: false`.
   */
  handoff(input: HandoffInput): { task: InboundTask; created: boolean } {
    const taskId = taskIdFor(input.accountId, input.userId, input.messageId);
    const existing = this.tasks.get(taskId);
    if (existing) return { task: clone(existing), created: false };
    const at = this.now();
    const task: InboundTask = {
      schemaVersion: 1,
      taskId,
      accountId: input.accountId,
      userId: input.userId,
      messageId: input.messageId,
      createdAt: at,
      updatedAt: at,
      phase: 'received',
      inbound: {
        text: input.text,
        refText: input.refText,
        ...(input.media && input.media.length > 0 ? { media: input.media } : {}),
        ...(input.generation !== undefined ? { generation: input.generation } : {}),
      },
      history: [{ phase: 'received', at }],
    };
    this.write('handoff', task);
    return { task: clone(task), created: true };
  }

  /** received → dispatching. Returns undefined when the task is not claimable. */
  claim(taskId: string, bootId: string): InboundTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.phase !== 'received') return undefined;
    const at = this.now();
    return this.transition('claim', task, {
      phase: 'dispatching',
      runner: { bootId, claimedAt: at },
    }, bootId);
  }

  /** dispatching → running, owned by `bootId`. Must precede adapter.execute. */
  markRunning(taskId: string, bootId: string, tool: string): InboundTask {
    const task = this.requireOwned(taskId, bootId, ['dispatching'], 'markRunning');
    return this.transition('running', task, {
      phase: 'running',
      agent: { tool, startedAt: this.now() },
    }, bootId);
  }

  /** running → delivery-pending with the Agent outcome as the durable source of truth. */
  recordOutcome(taskId: string, bootId: string, outcome: DeliveryOutcome): InboundTask {
    const task = this.requireOwned(taskId, bootId, ['running'], 'recordOutcome');
    return this.transition('outcome', task, { phase: 'delivery-pending', outcome }, bootId);
  }

  setFiles(taskId: string, files: TaskFileStep[]): InboundTask {
    const task = this.requirePhase(taskId, ['delivery-pending'], 'setFiles');
    return this.transition('files', task, { files });
  }

  setFileState(taskId: string, index: number, state: TaskFileStep['state'], error?: string): InboundTask {
    const task = this.requirePhase(taskId, ['delivery-pending'], 'setFileState');
    const files = (task.files || []).map((file, i) => (i === index
      ? { ...file, state, ...(error ? { error } : {}) }
      : file));
    return this.transition(`file:${index}:${state}`, task, { files });
  }

  setOutputs(taskId: string, outputs: TaskOutput[]): InboundTask {
    const task = this.requirePhase(taskId, ['delivery-pending', 'recovery-required'], 'setOutputs');
    return this.transition('outputs', task, { outputs });
  }

  markOutputEnqueued(taskId: string, index: number, itemIds: string[]): InboundTask {
    const task = this.requirePhase(taskId, ['delivery-pending', 'recovery-required'], 'markOutputEnqueued');
    const current = task.outputs?.[index];
    if (!current) throw new TaskTransitionError(taskId, task.phase, `markOutputEnqueued(${index})`);
    if (current.enqueued) return clone(task);
    const outputs = task.outputs!.map((output, i) => (i === index ? { ...output, enqueued: true, itemIds } : output));
    return this.transition(`enqueued:${index}`, task, { outputs });
  }

  complete(taskId: string, completion: TaskCompletion, detail?: string): InboundTask {
    const allowed: TaskPhase[] = completion === 'delivered'
      ? ['delivery-pending']
      : completion === 'operator-acknowledged'
        ? ['recovery-required']
        : ['dispatching', 'running'];
    const task = this.requirePhase(taskId, allowed, `complete(${completion})`);
    return this.transition('complete', task, {
      phase: 'completed',
      completion,
      ...(detail ? { completionDetail: detail } : {}),
    });
  }

  /** dispatching/running → recovery-required with diagnostics. Never reruns anything. */
  requireRecovery(taskId: string, diagnostic: TaskDiagnostic, notice?: TaskOutput): InboundTask {
    const task = this.requirePhase(taskId, ['dispatching', 'running'], 'requireRecovery');
    return this.transition('recovery', task, {
      phase: 'recovery-required',
      recovery: diagnostic,
      ...(notice ? { outputs: [notice] } : {}),
    }, diagnostic.detectedByBootId);
  }

  private requireOwned(taskId: string, bootId: string, phases: TaskPhase[], transition: string): InboundTask {
    const task = this.requirePhase(taskId, phases, transition);
    if (task.runner?.bootId !== bootId) {
      throw new TaskTransitionError(taskId, task.phase, `${transition} (owned by another runner)`);
    }
    return task;
  }

  private requirePhase(taskId: string, phases: TaskPhase[], transition: string): InboundTask {
    const task = this.tasks.get(taskId);
    if (!task || !phases.includes(task.phase)) throw new TaskTransitionError(taskId, task?.phase, transition);
    return task;
  }

  private transition(name: string, task: InboundTask, patch: Partial<InboundTask>, bootId?: string): InboundTask {
    const at = this.now();
    const next: InboundTask = { ...task, ...patch, updatedAt: at };
    if (patch.phase && patch.phase !== task.phase) {
      next.history = [...task.history, { phase: patch.phase, at, ...(bootId ? { bootId } : {}) }].slice(-MAX_HISTORY);
    }
    this.write(name, next);
    return clone(next);
  }

  private write(name: string, task: InboundTask): void {
    this.faultHook?.(`before:${name}`, clone(task));
    const nextTasks = new Map(this.tasks);
    nextTasks.set(task.taskId, task);
    this.prune(nextTasks);
    this.persist(nextTasks);
    this.tasks = nextTasks;
    this.faultHook?.(`after:${name}`, clone(task));
  }

  private prune(tasks: Map<string, InboundTask>): void {
    const now = this.now();
    for (const [taskId, task] of tasks) {
      if (task.phase === 'completed' && now - task.updatedAt > this.completedRetentionMs) tasks.delete(taskId);
      else if (task.phase === 'recovery-required' && now - task.updatedAt > this.recoveryRetentionMs) tasks.delete(taskId);
    }
    if (tasks.size <= this.maxRetainedTasks) return;
    // Over the cap, drop the oldest terminal tasks first; live tasks are never evicted.
    const terminal = [...tasks.values()]
      .filter((task) => task.phase === 'completed' || task.phase === 'recovery-required')
      .sort((a, b) => (a.phase === b.phase ? 0 : a.phase === 'completed' ? -1 : 1) || a.updatedAt - b.updatedAt);
    for (const task of terminal) {
      if (tasks.size <= this.maxRetainedTasks) break;
      tasks.delete(task.taskId);
    }
  }

  private persist(tasks: Map<string, InboundTask>): void {
    if (!this.filePath) return;
    const payload: PersistedTasks = { schemaVersion: 1, tasks: [...tasks.values()] };
    atomicWrite(this.filePath, JSON.stringify(payload));
  }

  private load(filePath: string): void {
    if (!existsSync(filePath)) return;
    let parsed: Partial<PersistedTasks>;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedTasks>;
    } catch (err) {
      // Never silently discard durable state: move it aside for an operator and
      // start empty. Inbounds it covered have already been acknowledged, so the
      // only consequence is that their tasks are not resumed.
      const aside = `${filePath}.corrupt-${this.now()}`;
      try { renameSync(filePath, aside); } catch { /* best effort */ }
      throw new TaskStoreCorruptionError(filePath, aside, err);
    }
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) {
      const aside = `${filePath}.corrupt-${this.now()}`;
      try { renameSync(filePath, aside); } catch { /* best effort */ }
      throw new TaskStoreCorruptionError(filePath, aside, new Error('unsupported schema'));
    }
    for (const task of parsed.tasks) {
      if (task && typeof task.taskId === 'string' && typeof task.phase === 'string') this.tasks.set(task.taskId, task);
    }
  }
}

export class TaskStoreCorruptionError extends Error {
  constructor(public readonly filePath: string, public readonly movedTo: string | undefined, public readonly cause: unknown) {
    super(`inbound task store is unreadable: ${filePath}${movedTo ? ` (moved to ${movedTo})` : ''}`);
    this.name = 'TaskStoreCorruptionError';
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
