import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ILinkClient } from '../src/ilink/client.js';
import { Router } from '../src/bridge/router.js';
import { InboundTaskStore, TaskTransitionError, type InboundTask } from '../src/bridge/task-store.js';
import type { BridgeConfig } from '../src/config.js';
import type { Credentials, WeixinMessage } from '../src/ilink/types.js';
import type { OutboxItem } from '../src/ilink/outbox.js';

// Failure-injection harness for issue #27.
//
// A "process" is an ILinkClient (real outbox, quota ledger, delivery receipts,
// poll cursor) plus a Router with a durable InboundTaskStore, all rooted in one
// directory. Only the wire is faked: sendRawTextMessage records what reached
// WeChat and getUpdates returns scripted batches.
//
// A crash is modelled by copying the data directory at an exact durable
// transition (the task store's before:/after: fault points). The next boot
// starts from that copy with a new bootId, which is precisely the disk state a
// SIGKILL at that instant would leave. Effects of the old process after the
// snapshot (adapter calls, sends) are discarded, as a real crash would.

const CREDS: Credentials = {
  botToken: 'token',
  baseUrl: 'https://example.test',
  ilinkBotId: 'account-a',
  ilinkUserId: 'bot-user',
};
const UID = 'user-a';

type Mode = 'compact' | 'normal' | 'verbose';
type Adapter = (prompt: string, options: any) => Promise<{ text: string; error?: boolean; thinking?: string; duration?: number }>;
type SendFault = (item: OutboxItem) => void;

interface BootOptions {
  bootId: string;
  adapter?: Adapter;
  mode?: Mode;
  showThoughts?: boolean;
  faultHook?: (point: string, task: InboundTask) => void;
  sendFault?: SendFault;
  clientOptions?: Record<string, unknown>;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'inbound-lifecycle-'));
}

function filesIn(dir: string) {
  return {
    outboxPath: join(dir, 'outbox.json'),
    quotaPath: join(dir, 'quota.json'),
    diagnosticsPath: join(dir, 'delivery-diagnostics.jsonl'),
    contextTokensPath: join(dir, 'context_tokens.json'),
    pollCursorPath: join(dir, 'poll_cursor.txt'),
    tasksPath: join(dir, 'inbound-tasks.json'),
  };
}

function inbound(id: number, text = 'do the thing', contextToken: string | undefined = 'ctx-1'): WeixinMessage {
  return {
    message_id: id,
    from_user_id: UID,
    to_user_id: 'bot-user',
    client_id: `inbound-${id}`,
    create_time_ms: 1_000 + id,
    message_type: 1,
    message_state: 0,
    ...(contextToken ? { context_token: contextToken } : {}),
    item_list: [{ type: 1, text_item: { text } }],
  } as WeixinMessage;
}

const defaultAdapter: Adapter = async () => ({ text: 'answer-1', duration: 1_000, error: false });

function boot(dir: string, options: BootOptions) {
  const files = filesIn(dir);
  const client = new ILinkClient(CREDS, {
    outboxPath: files.outboxPath,
    quotaPath: files.quotaPath,
    diagnosticsPath: files.diagnosticsPath,
    contextTokensPath: files.contextTokensPath,
    pollCursorPath: files.pollCursorPath,
    rateLimitBaseCooldownMs: 0,
    rateLimitMaxCooldownMs: 0,
    ...options.clientOptions,
  });
  const delivered: string[] = [];
  const sendAttempts: string[] = [];
  const anyClient = client as any;
  anyClient.sendRawTextMessage = async (_userId: string, _token: string, item: OutboxItem) => {
    sendAttempts.push(item.text);
    options.sendFault?.(item);
    delivered.push(item.text);
  };
  anyClient.startTyping = async () => () => {};
  const fileSends: string[] = [];
  anyClient.sendFile = anyClient.sendImage = anyClient.sendVideo = async (_userId: string, path: string) => {
    fileSends.push(path);
  };

  const adapterCalls: string[] = [];
  const adapter = options.adapter ?? defaultAdapter;
  const registry = {
    isAvailable: (name: string) => name === 'codex',
    getNameByDisplayName: () => undefined,
    getAvailableNames: () => ['codex'],
    get: (name: string) => (name === 'codex' ? {
      name: 'codex',
      displayName: 'Codex',
      capabilities: { sessionResume: false },
      execute: async (prompt: string, execOptions: any) => {
        adapterCalls.push(prompt);
        return adapter(prompt, execOptions);
      },
    } : undefined),
  };
  const settings = new Map<string, any>();
  const sessions = {
    get: (uid: string) => {
      if (!settings.has(uid)) {
        settings.set(uid, {
          defaultTool: 'codex', sessionIds: {}, msgMode: options.mode ?? 'compact', showThoughts: options.showThoughts ?? false,
        });
      }
      return settings.get(uid);
    },
    update: (uid: string, partial: object) => Object.assign(sessions.get(uid), partial),
    setSession: () => {},
    clearSession: () => {},
  };
  const config: BridgeConfig = {
    defaultTool: 'codex',
    maxResponseChunkSize: 2000,
    cliTimeout: 300_000,
    typingInterval: 5000,
    allowedUsers: [],
    allowAllUsers: true,
    workDir: dir,
    tools: {},
  };
  const store = new InboundTaskStore(files.tasksPath, { faultHook: options.faultHook });
  const router = new Router(client, registry as any, sessions as any, config, { taskStore: store, bootId: options.bootId });
  (router as any).sleep = async () => {};
  router.start();

  return {
    dir,
    client,
    router,
    store,
    delivered,
    sendAttempts,
    fileSends,
    adapterCalls,
    /** One long-poll round: the batch is processed, then the cursor is committed. */
    async poll(msgs: WeixinMessage[], cursor: string): Promise<void> {
      anyClient.getUpdates = async () => {
        anyClient.pendingPollCursor = cursor;
        return msgs;
      };
      await anyClient.pollOnce();
    },
    cursor(): string {
      return existsSync(files.pollCursorPath) ? readFileSync(files.pollCursorPath, 'utf8') : '';
    },
    outbox(): OutboxItem[] {
      return anyClient.outbox.list(UID);
    },
    tasks(): InboundTask[] {
      return store.list();
    },
    async idle(): Promise<void> {
      await router.whenIdle();
      await router.whenIdle();
    },
  };
}

type Process = ReturnType<typeof boot>;

/** Arm a crash at one durable fault point; returns what had happened up to that instant. */
function crashAt(point: string, dir: string) {
  const snapshotDir = freshDir();
  const state = { fired: false, delivered: 0, adapterCalls: 0, fileSends: 0, process: undefined as Process | undefined };
  const hook = (name: string) => {
    if (state.fired || name !== point) return;
    state.fired = true;
    cpSync(dir, snapshotDir, { recursive: true });
    // The hook can fire inside boot() (restart reconciliation) before `process` is set.
    state.delivered = state.process?.delivered.length ?? 0;
    state.adapterCalls = state.process?.adapterCalls.length ?? 0;
    state.fileSends = state.process?.fileSends.length ?? 0;
  };
  return { snapshotDir, state, hook };
}

// ─── Baseline ────────────────────────────────────────────

test('a fresh inbound is handed off before the cursor commits and the agent runs in the background', async () => {
  const dir = freshDir();
  let releaseAgent!: () => void;
  const agentGate = new Promise<void>((resolve) => { releaseAgent = resolve; });
  const proc = boot(dir, {
    bootId: 'boot-1',
    adapter: async () => {
      await agentGate;
      return { text: 'answer-1', duration: 1_000 };
    },
  });

  await proc.poll([inbound(1)], 'cursor-1');

  // The poll round finished while the agent is still blocked: the HTTP poll is
  // not held open for the agent's lifetime, yet the inbound is durable.
  assert.equal(proc.cursor(), 'cursor-1');
  const [task] = proc.tasks();
  assert.equal(task.taskId, 'account-a:user-a:1');
  assert.equal(task.inbound.text, 'do the thing');
  assert.ok(['received', 'dispatching', 'running'].includes(task.phase));

  releaseAgent();
  await proc.idle();
  assert.equal(proc.adapterCalls.length, 1);
  assert.equal(proc.tasks()[0].phase, 'completed');
  assert.equal(proc.tasks()[0].completion, 'delivered');
  assert.equal(proc.delivered.length, 1);
  assert.match(proc.delivered[0], /^answer-1\n\n— Codex \| 1\.0s$/);
  assert.deepEqual(proc.outbox(), []);
  assert.deepEqual(proc.tasks()[0].history.map((entry) => entry.phase), [
    'received', 'dispatching', 'running', 'delivery-pending', 'completed',
  ]);
});

test('a handoff persistence failure leaves the inbound and cursor replayable', async () => {
  const dir = freshDir();
  let failHandoff = true;
  const proc = boot(dir, {
    bootId: 'boot-1',
    faultHook: (point) => {
      if (point === 'before:handoff' && failHandoff) throw new Error('disk full');
    },
  });

  await assert.rejects(proc.poll([inbound(1)], 'cursor-1'), /disk full/);
  assert.equal(proc.cursor(), '');
  assert.deepEqual(proc.tasks(), []);
  assert.equal(proc.adapterCalls.length, 0);
  const quota = JSON.parse(readFileSync(filesIn(dir).quotaPath, 'utf8'));
  assert.deepEqual(quota.users['account-a\u0000user-a'].pendingInboundIds, ['1']);

  failHandoff = false;
  await proc.poll([inbound(1)], 'cursor-1');
  await proc.idle();
  assert.equal(proc.cursor(), 'cursor-1');
  assert.equal(proc.adapterCalls.length, 1);
  assert.equal(proc.delivered.length, 1);
  assert.equal(proc.tasks()[0].phase, 'completed');
});

test('a failing message in a batch keeps the whole batch replayable without re-running handed-off work', async () => {
  const dir = freshDir();
  let failSecond = true;
  const proc = boot(dir, {
    bootId: 'boot-1',
    faultHook: (point, task) => {
      if (point === 'before:handoff' && task.messageId === '2' && failSecond) throw new Error('write failed');
    },
  });

  await assert.rejects(proc.poll([inbound(1, 'first'), inbound(2, 'second')], 'cursor-1'), /write failed/);
  assert.equal(proc.cursor(), '');
  await proc.idle();

  failSecond = false;
  await proc.poll([inbound(1, 'first'), inbound(2, 'second')], 'cursor-1');
  await proc.idle();
  assert.equal(proc.cursor(), 'cursor-1');
  assert.equal(proc.adapterCalls.length, 2);
  assert.deepEqual(proc.adapterCalls.map((prompt) => prompt.split('\n')[0]), ['first', 'second']);
  assert.equal(proc.tasks().length, 2);
});

// ─── Crash matrix ────────────────────────────────────────

interface Expectation {
  /** Durable phase of the task as seen by the restarted process after recovery settles. */
  phase: InboundTask['phase'];
  /** Adapter invocations across both boots, counting the first boot only up to the crash. */
  adapterTotal: number;
  /** Adapter invocations by the restarted boot. Must be 0 once `running` was durable. */
  adapterAfterRestart: number;
  answerDeliveries: number;
  noticeDeliveries: number;
  recovery?: string;
}

const CRASH_MATRIX: Array<[string, Expectation]> = [
  ['before:handoff', { phase: 'completed', adapterTotal: 1, adapterAfterRestart: 1, answerDeliveries: 1, noticeDeliveries: 0 }],
  ['after:handoff', { phase: 'completed', adapterTotal: 1, adapterAfterRestart: 1, answerDeliveries: 1, noticeDeliveries: 0 }],
  ['before:claim', { phase: 'completed', adapterTotal: 1, adapterAfterRestart: 1, answerDeliveries: 1, noticeDeliveries: 0 }],
  ['after:claim', { phase: 'recovery-required', adapterTotal: 0, adapterAfterRestart: 0, answerDeliveries: 0, noticeDeliveries: 1, recovery: 'interrupted-during-dispatch' }],
  ['before:running', { phase: 'recovery-required', adapterTotal: 0, adapterAfterRestart: 0, answerDeliveries: 0, noticeDeliveries: 1, recovery: 'interrupted-during-dispatch' }],
  ['after:running', { phase: 'recovery-required', adapterTotal: 0, adapterAfterRestart: 0, answerDeliveries: 0, noticeDeliveries: 1, recovery: 'agent-interrupted' }],
  ['before:outcome', { phase: 'recovery-required', adapterTotal: 1, adapterAfterRestart: 0, answerDeliveries: 0, noticeDeliveries: 1, recovery: 'agent-interrupted' }],
  ['after:outcome', { phase: 'completed', adapterTotal: 1, adapterAfterRestart: 0, answerDeliveries: 1, noticeDeliveries: 0 }],
  ['before:enqueued:0', { phase: 'completed', adapterTotal: 1, adapterAfterRestart: 0, answerDeliveries: 1, noticeDeliveries: 0 }],
  ['after:enqueued:0', { phase: 'completed', adapterTotal: 1, adapterAfterRestart: 0, answerDeliveries: 1, noticeDeliveries: 0 }],
  ['before:complete', { phase: 'completed', adapterTotal: 1, adapterAfterRestart: 0, answerDeliveries: 1, noticeDeliveries: 0 }],
  ['after:complete', { phase: 'completed', adapterTotal: 1, adapterAfterRestart: 0, answerDeliveries: 1, noticeDeliveries: 0 }],
];

for (const [point, expected] of CRASH_MATRIX) {
  test(`crash at ${point} recovers to exactly one valid next action`, async () => {
    const dir = freshDir();
    const crash = crashAt(point, dir);
    const first = boot(dir, { bootId: 'boot-1', faultHook: crash.hook });
    crash.state.process = first;

    // The first boot's poll round may itself be the crash site (handoff); a
    // crashed process acknowledges nothing, so only the snapshot matters.
    await first.poll([inbound(1)], 'cursor-1').catch(() => {});
    await first.idle();
    assert.equal(crash.state.fired, true, `fault point ${point} was never reached`);

    const second = boot(crash.snapshotDir, { bootId: 'boot-2' });
    // An unrelated drain (e.g. a rate-limit recovery timer) races the restarted
    // runner for the outbox before any task work is scheduled.
    const racingDrain = second.client.recoverPending(UID);
    const cursorAtRestart = second.cursor();
    if (point === 'before:handoff' || point === 'after:handoff') {
      // Nothing was acknowledged: the cursor must not have moved past the inbound.
      assert.equal(cursorAtRestart, '');
    }
    // The server replays anything the cursor did not cover, possibly while the
    // restarted runner is already working on the same task.
    await second.poll(cursorAtRestart === 'cursor-1' ? [] : [inbound(1)], 'cursor-1');
    await racingDrain;
    await second.idle();

    const tasks = second.tasks();
    assert.equal(tasks.length, 1, 'exactly one durable task for the inbound');
    const [task] = tasks;
    assert.equal(task.phase, expected.phase);
    assert.equal(task.recovery?.reason, expected.recovery);
    if (expected.recovery) {
      assert.equal(task.recovery?.ownerBootId, 'boot-1');
      assert.equal(task.recovery?.detectedByBootId, 'boot-2');
      assert.ok(task.recovery?.detail);
    }
    assert.equal(second.cursor(), 'cursor-1');
    assert.equal(second.adapterCalls.length, expected.adapterAfterRestart);
    assert.equal(crash.state.adapterCalls + second.adapterCalls.length, expected.adapterTotal);

    const visible = [...first.delivered.slice(0, crash.state.delivered), ...second.delivered];
    assert.equal(visible.filter((text) => text.startsWith('answer-1')).length, expected.answerDeliveries);
    assert.equal(visible.filter((text) => text.startsWith('⚠️')).length, expected.noticeDeliveries);
    assert.equal(visible.length, expected.answerDeliveries + expected.noticeDeliveries);
    assert.deepEqual(second.outbox(), [], 'nothing left behind in the outbox');

    // A further restart is a no-op: terminal phases never re-run or re-send.
    const third = boot(crash.snapshotDir, { bootId: 'boot-3' });
    await third.poll([], 'cursor-1');
    await third.idle();
    assert.equal(third.adapterCalls.length, 0);
    assert.equal(third.delivered.length, 0);
  });
}

test('a crash while recovering an interrupted task still yields exactly one notice', async () => {
  for (const point of ['before:recovery', 'after:recovery', 'before:enqueued:0', 'after:enqueued:0']) {
    const dir = freshDir();
    const firstCrash = crashAt('after:running', dir);
    const first = boot(dir, { bootId: 'boot-1', faultHook: firstCrash.hook });
    firstCrash.state.process = first;
    await first.poll([inbound(1)], 'cursor-1');
    await first.idle();

    const secondCrash = crashAt(point, firstCrash.snapshotDir);
    const second = boot(firstCrash.snapshotDir, { bootId: 'boot-2', faultHook: secondCrash.hook });
    secondCrash.state.process = second;
    await second.idle();
    assert.equal(secondCrash.state.fired, true, point);

    const third = boot(secondCrash.snapshotDir, { bootId: 'boot-3' });
    await third.idle();
    const visible = [...second.delivered.slice(0, secondCrash.state.delivered), ...third.delivered];
    assert.equal(visible.length, 1, point);
    assert.match(visible[0], /^⚠️ 桥接服务中断时 codex 仍在执行/);
    const [task] = third.tasks();
    assert.equal(task.phase, 'recovery-required');
    assert.equal(task.recovery?.ownerBootId, 'boot-1', point);
    assert.equal(second.adapterCalls.length + third.adapterCalls.length, 0);
  }
});

// ─── Concurrency ─────────────────────────────────────────

test('concurrent replay of the same inbound starts a single runner', async () => {
  const dir = freshDir();
  const proc = boot(dir, { bootId: 'boot-1' });
  const accept = (proc.router as any).acceptInbound.bind(proc.router);

  // Bypass the client's in-memory de-dup to model replays racing each other
  // and the genuine poll delivery of the same inbound.
  await Promise.all([
    proc.poll([inbound(1)], 'cursor-1'),
    Promise.resolve().then(() => accept(inbound(1), 'do the thing', '')),
    Promise.resolve().then(() => accept(inbound(1), 'do the thing', '')),
  ]);
  await proc.idle();

  assert.equal(proc.adapterCalls.length, 1);
  assert.equal(proc.tasks().length, 1);
  assert.equal(proc.delivered.filter((text) => text.startsWith('answer-1')).length, 1);
});

test('a restart racing a poll replay of a received task runs the agent once', async () => {
  const dir = freshDir();
  const crash = crashAt('after:handoff', dir);
  const first = boot(dir, { bootId: 'boot-1', faultHook: crash.hook });
  crash.state.process = first;
  await first.poll([inbound(1)], 'cursor-1');
  await first.idle();

  const second = boot(crash.snapshotDir, { bootId: 'boot-2' });
  // recoverTasks() already scheduled the runner; replay the inbound twice at once.
  await Promise.all([
    second.poll([inbound(1)], 'cursor-1'),
    (second.router as any).acceptInbound(inbound(1), 'do the thing', ''),
  ]);
  await second.idle();

  assert.equal(second.adapterCalls.length, 1);
  assert.equal(second.delivered.filter((text) => text.startsWith('answer-1')).length, 1);
});

test('a task owned by another boot cannot be advanced by this one', () => {
  const store = new InboundTaskStore();
  const { task } = store.handoff({ accountId: 'a', userId: 'u', messageId: '1', text: 't', refText: '' });
  assert.ok(store.claim(task.taskId, 'boot-1'));
  assert.equal(store.claim(task.taskId, 'boot-2'), undefined);
  assert.throws(() => store.markRunning(task.taskId, 'boot-2', 'codex'), TaskTransitionError);
  store.markRunning(task.taskId, 'boot-1', 'codex');
  assert.throws(() => store.recordOutcome(task.taskId, 'boot-2', { kind: 'texts', texts: [] }), TaskTransitionError);
  assert.equal(store.handoff({ accountId: 'a', userId: 'u', messageId: '1', text: 'again', refText: '' }).created, false);
});

// ─── Output content/order across restart ─────────────────

function streamingAdapter(): Adapter {
  return async (_prompt, options) => {
    options.onIntermediate?.({ type: 'text', content: 'streamed answer' });
    for (let i = 0; i < 16; i += 1) {
      options.onIntermediate?.({ type: 'tool_use', content: `- Shell Command: step ${i + 1} ${'z'.repeat(90)}` });
    }
    return { text: 'streamed answer', thinking: 'quiet thoughts', duration: 2_000 };
  };
}

for (const mode of ['compact', 'normal', 'verbose'] as const) {
  test(`${mode} output content and FIFO order survive a crash after the outcome is durable`, async () => {
    const baselineDir = freshDir();
    const baseline = boot(baselineDir, { bootId: 'baseline', mode, showThoughts: true, adapter: streamingAdapter() });
    await baseline.poll([inbound(1)], 'cursor-1');
    await baseline.idle();
    assert.ok(baseline.delivered.length >= 1);

    for (const point of ['after:outcome', 'after:enqueued:0', 'before:enqueued:1', 'after:enqueued:1']) {
      const dir = freshDir();
      const crash = crashAt(point, dir);
      const first = boot(dir, { bootId: 'boot-1', mode, showThoughts: true, adapter: streamingAdapter(), faultHook: crash.hook });
      crash.state.process = first;
      await first.poll([inbound(1)], 'cursor-1');
      await first.idle();
      if (!crash.state.fired) {
        // Single-output modes have no second output to crash before.
        assert.match(point, /enqueued:1$/);
        continue;
      }

      const second = boot(crash.snapshotDir, { bootId: 'boot-2', mode, showThoughts: true, adapter: streamingAdapter() });
      await second.idle();
      const visible = [...first.delivered.slice(0, crash.state.delivered), ...second.delivered];
      assert.deepEqual(visible, baseline.delivered, `${mode} @ ${point}`);
      assert.equal(second.adapterCalls.length, 0);
      assert.equal(second.tasks()[0].phase, 'completed');
    }
  });
}

// ─── Delivery failures never re-invoke the agent ─────────

test('an ambiguous final send is recovered by the outbox on a later inbound without re-running the agent', async () => {
  const dir = freshDir();
  let failFinal = true;
  const proc = boot(dir, {
    bootId: 'boot-1',
    sendFault: (item) => {
      if (failFinal && item.text.startsWith('answer-1')) {
        failFinal = false;
        throw { details: { errmsg: 'socket hang up' } };
      }
    },
  });
  await proc.poll([inbound(1)], 'cursor-1');
  await proc.idle();
  assert.equal(proc.delivered.length, 0);
  assert.equal(proc.outbox()[0].failureKind, 'ambiguous-delivery');

  await proc.poll([inbound(2, '/status')], 'cursor-2');
  await proc.idle();
  assert.equal(proc.adapterCalls.length, 1);
  assert.equal(proc.delivered.filter((text) => text.startsWith('answer-1')).length, 1);
  // The retry reuses the frozen client_id so iLink can de-duplicate it.
  assert.equal(proc.sendAttempts.filter((text) => text.startsWith('answer-1')).length, 2);
});

test('a rate-limited final waits in the outbox and is resumed without re-running the agent', async () => {
  const dir = freshDir();
  let limited = true;
  const proc = boot(dir, {
    bootId: 'boot-1',
    clientOptions: { rateLimitBaseCooldownMs: 60_000, rateLimitMaxCooldownMs: 60_000 },
    sendFault: (item) => {
      if (limited && item.text.startsWith('answer-1')) {
        limited = false;
        throw { details: { ret: -2, errmsg: 'rate limited' } };
      }
    },
  });
  await proc.poll([inbound(1)], 'cursor-1');
  await proc.idle();
  assert.equal(proc.delivered.length, 0);
  assert.equal(proc.tasks()[0].phase, 'delivery-pending');

  // A fresh context token opens a new window and clears the backoff.
  await proc.poll([inbound(2, '继续', 'ctx-2')], 'cursor-2');
  await proc.idle();
  assert.equal(proc.adapterCalls.length, 1);
  assert.deepEqual(proc.delivered.map((text) => text.split('\n')[0]), ['answer-1']);
  assert.equal(proc.tasks().find((task) => task.messageId === '1')?.phase, 'completed');
});

test('a missing context token keeps the output pending until a later inbound supplies one', async () => {
  const dir = freshDir();
  const proc = boot(dir, { bootId: 'boot-1' });
  await proc.poll([inbound(1, 'do the thing', '')], 'cursor-1');
  await proc.idle();
  assert.equal(proc.delivered.length, 0);
  assert.equal(proc.tasks()[0].phase, 'delivery-pending');
  assert.equal(proc.outbox().length, 1);

  // Restart in between: still only delivery is resumed.
  const second = boot(dir, { bootId: 'boot-2' });
  await second.idle();
  assert.equal(second.adapterCalls.length, 0);
  await second.poll([inbound(2, '继续', 'ctx-2')], 'cursor-2');
  await second.idle();
  assert.equal(proc.adapterCalls.length + second.adapterCalls.length, 1);
  assert.deepEqual(second.delivered.map((text) => text.split('\n')[0]), ['answer-1']);
  assert.equal(second.tasks().find((task) => task.messageId === '1')?.phase, 'completed');
});

test('an outbox persistence failure for the final keeps the task delivery-pending and resumes it later', async () => {
  const dir = freshDir();
  const proc = boot(dir, { bootId: 'boot-1' });
  const outbox = (proc.client as any).outbox;
  const original = outbox.enqueueTextBatch.bind(outbox);
  let failures = 1;
  outbox.enqueueTextBatch = (inputs: any[]) => {
    if (failures > 0 && inputs[0]?.itemId?.includes(':o0#')) {
      failures -= 1;
      throw new Error('outbox write failed');
    }
    return original(inputs);
  };
  await proc.poll([inbound(1)], 'cursor-1');
  await proc.idle();
  const [task] = proc.tasks();
  assert.equal(task.phase, 'delivery-pending');
  assert.equal(task.outputs?.[0].enqueued, false);
  assert.equal(proc.delivered.length, 0);

  await proc.poll([inbound(2, '/status')], 'cursor-2');
  await proc.idle();
  assert.equal(proc.adapterCalls.length, 1);
  assert.equal(proc.delivered.filter((text) => text.startsWith('answer-1')).length, 1);
  assert.equal(proc.tasks().find((t) => t.messageId === '1')?.phase, 'completed');
});

test('quota exhaustion splits delivery across inbound windows without re-running the agent', async () => {
  const dir = freshDir();
  const long = Array.from({ length: 6 }, (_, i) => `para-${i + 1} ${'x'.repeat(150)}`).join('\n\n');
  const proc = boot(dir, {
    bootId: 'boot-1',
    adapter: async () => ({ text: long, duration: 1_000 }),
    clientOptions: { maxItemsPerWindow: 2, maxTextBytes: 400 },
  });
  await proc.poll([inbound(1)], 'cursor-1');
  await proc.idle();
  assert.equal(proc.delivered.length, 2);
  assert.ok(proc.delivered[1].endsWith('后续内容已排队，请回复“继续”续发。'));
  assert.equal(proc.tasks()[0].phase, 'delivery-pending');

  for (let i = 2; proc.tasks().find((t) => t.messageId === '1')?.phase !== 'completed' && i < 10; i += 1) {
    const restarted = boot(dir, { bootId: `boot-${i}`, clientOptions: { maxItemsPerWindow: 2, maxTextBytes: 400 } });
    await restarted.poll([inbound(i, '继续')], `cursor-${i}`);
    await restarted.idle();
    assert.equal(restarted.adapterCalls.length, 0);
    proc.delivered.push(...restarted.delivered);
    proc.tasks = () => restarted.tasks();
  }
  assert.equal(proc.adapterCalls.length, 1);
  const body = proc.delivered.map((text) => text.replace(/\n\n后续内容已排队，请回复“继续”续发。$/, '')).join('');
  for (let i = 1; i <= 6; i += 1) assert.ok(body.includes(`para-${i}`));
});

// ─── Independence from existing delivery concerns ────────

test('inbound de-duplication still drops a replay of a completed inbound after restart', async () => {
  const dir = freshDir();
  const first = boot(dir, { bootId: 'boot-1' });
  await first.poll([inbound(1)], 'cursor-1');
  await first.idle();
  // Simulate a lost cursor (e.g. restored from an old backup): the server replays.
  writeFileSync(filesIn(dir).pollCursorPath, '');

  const second = boot(dir, { bootId: 'boot-2' });
  await second.poll([inbound(1)], 'cursor-1');
  await second.idle();
  assert.equal(second.adapterCalls.length, 0);
  assert.equal(second.delivered.length, 0);
  assert.equal(second.tasks().length, 1);
});

test('a confirmed send whose ack failed is reconciled from its delivery receipt, not resent', async () => {
  const dir = freshDir();
  const first = boot(dir, { bootId: 'boot-1' });
  const outbox = (first.client as any).outbox;
  outbox.ack = () => { throw new Error('ack write failed'); };
  await first.poll([inbound(1)], 'cursor-1');
  await first.idle();
  assert.equal(first.delivered.length, 1);
  assert.ok(first.outbox()[0].deliveryReceipt, 'receipt persisted before the failed ack');
  assert.equal(first.tasks()[0].phase, 'delivery-pending');

  const second = boot(dir, { bootId: 'boot-2' });
  await second.idle();
  assert.equal(second.adapterCalls.length, 0);
  assert.equal(second.delivered.length, 0, 'receipt reconciliation acks without resending');
  assert.equal(second.tasks()[0].phase, 'completed');
  assert.deepEqual(second.outbox(), []);
});

test('a deterministic rejection stays in outbox failure retention while the task completes', async () => {
  const dir = freshDir();
  const proc = boot(dir, {
    bootId: 'boot-1',
    sendFault: (item) => {
      if (item.text.startsWith('answer-1')) throw { details: { httpStatus: 400, errmsg: 'bad request' } };
    },
  });
  await proc.poll([inbound(1)], 'cursor-1');
  await proc.idle();
  const [task] = proc.tasks();
  assert.equal(task.phase, 'completed');
  assert.match(task.completionDetail || '', /failed items: account-a:user-a:1:o0#0/);
  assert.equal(proc.outbox()[0].state, 'permanent-failure');
  assert.equal(proc.outbox()[0].failureKind, 'deterministic-rejection');
});

// ─── Operator visibility and store hygiene ───────────────

test('/tasks lists recovery-required diagnostics and /tasks ack resolves them', async () => {
  const dir = freshDir();
  const crash = crashAt('after:running', dir);
  const first = boot(dir, { bootId: 'boot-1', faultHook: crash.hook });
  crash.state.process = first;
  await first.poll([inbound(1)], 'cursor-1');
  await first.idle();

  const second = boot(crash.snapshotDir, { bootId: 'boot-2' });
  await second.idle();
  await second.poll([inbound(2, '/tasks')], 'cursor-2');
  await second.idle();
  const listing = second.delivered.at(-1) || '';
  assert.match(listing, /\[recovery-required\]/);
  assert.match(listing, /agent-interrupted/);
  assert.match(listing, /agent: codex/);

  await second.poll([inbound(3, '/status')], 'cursor-3');
  await second.idle();
  assert.match(second.delivered.at(-1) || '', /tasks: delivery-pending=0 recovery-required=1/);

  await second.poll([inbound(4, '/tasks ack')], 'cursor-4');
  await second.idle();
  assert.match(second.delivered.at(-1) || '', /已确认 1 个中断任务/);
  const task = second.tasks().find((t) => t.messageId === '1');
  assert.equal(task?.phase, 'completed');
  assert.equal(task?.completion, 'operator-acknowledged');
  assert.equal(second.adapterCalls.length, 0);
});

test('a user cancel completes the task while a shutdown abort leaves it for recovery', async () => {
  for (const how of ['cancel', 'shutdown'] as const) {
    const dir = freshDir();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const proc = boot(dir, {
      bootId: 'boot-1',
      adapter: (_prompt, options) => new Promise((resolve) => {
        started();
        options.signal.addEventListener('abort', () => resolve({ text: '已取消', error: true }));
      }),
    });
    await proc.poll([inbound(1)], 'cursor-1');
    await running;
    if (how === 'cancel') {
      await proc.poll([inbound(2, '/cancel')], 'cursor-2');
    } else {
      proc.router.stop();
    }
    await proc.idle();
    const task = proc.tasks().find((t) => t.messageId === '1')!;
    if (how === 'cancel') {
      assert.equal(task.phase, 'completed');
      assert.equal(task.completion, 'cancelled');
    } else {
      assert.equal(task.phase, 'running');
      const next = boot(dir, { bootId: 'boot-2' });
      await next.idle();
      assert.equal(next.tasks().find((t) => t.messageId === '1')?.recovery?.reason, 'agent-interrupted');
      assert.equal(next.adapterCalls.length, 0);
    }
  }
});

test('an interrupted media send is reported, never resent', async () => {
  const dir = freshDir();
  const file = join(dir, 'report.txt');
  writeFileSync(file, 'report');
  const crash = crashAt('after:file:0:sending', dir);
  const first = boot(dir, {
    bootId: 'boot-1',
    faultHook: crash.hook,
    adapter: async () => ({ text: `done [SEND_FILE: ${file}]`, duration: 1_000 }),
  });
  crash.state.process = first;
  await first.poll([inbound(1)], 'cursor-1');
  await first.idle();

  const second = boot(crash.snapshotDir, { bootId: 'boot-2' });
  await second.idle();
  assert.equal(second.fileSends.length, 0);
  assert.equal(second.adapterCalls.length, 0);
  assert.equal(second.delivered.length, 1);
  assert.match(second.delivered[0], /^done\n\[⚠️ 文件发送失败: report\.txt（发送中断，无法确认是否已送达，未重发）\]/);
});

test('a crash around each media step sends the file and the final answer exactly once', async () => {
  for (const point of ['after:outcome', 'before:files', 'after:files', 'after:file:0:sent', 'before:outputs', 'after:outputs']) {
    const dir = freshDir();
    const file = join(dir, 'report.txt');
    writeFileSync(file, 'report');
    const adapter: Adapter = async () => ({ text: `done [SEND_FILE: ${file}]`, duration: 1_000 });
    const crash = crashAt(point, dir);
    const first = boot(dir, { bootId: 'boot-1', faultHook: crash.hook, adapter });
    crash.state.process = first;
    await first.poll([inbound(1)], 'cursor-1');
    await first.idle();
    assert.equal(crash.state.fired, true, point);

    const second = boot(crash.snapshotDir, { bootId: 'boot-2', adapter });
    await second.idle();
    assert.equal(crash.state.adapterCalls + second.adapterCalls.length, 1, point);
    assert.equal(second.adapterCalls.length, 0, point);
    assert.equal(crash.state.fileSends + second.fileSends.length, 1, point);
    const visible = [...first.delivered.slice(0, crash.state.delivered), ...second.delivered];
    assert.equal(visible.length, 1, point);
    assert.match(visible[0], /^done\n\[已发送文件: report\.txt\]/, point);
    assert.equal(second.tasks()[0].phase, 'completed', point);
  }
});

test('a corrupt task ledger is moved aside instead of being silently discarded', () => {
  const dir = freshDir();
  const path = join(dir, 'inbound-tasks.json');
  writeFileSync(path, '{not json');
  const store = new InboundTaskStore(path);
  assert.deepEqual(store.list(), []);
  assert.ok(store.corruption?.movedTo);
  assert.equal(existsSync(path), false);
  assert.ok(readdirSync(dir).some((name) => name.startsWith('inbound-tasks.json.corrupt-')));
  assert.deepEqual(new InboundTaskStore(path).list(), []);
});

test('a corrupt ledger that cannot be moved aside still lets the bridge start', () => {
  const dir = freshDir();
  const path = join(dir, 'inbound-tasks.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 99, tasks: [] }));
  const mode = statSync(dir).mode;
  chmodSync(dir, 0o500);
  try {
    const store = new InboundTaskStore(path);
    assert.deepEqual(store.list(), []);
    assert.equal(store.corruption?.reason, 'unsupported schema');
    assert.equal(store.corruption?.movedTo, undefined);
    // And a second construction (e.g. a supervisor restart) does not throw either.
    assert.deepEqual(new InboundTaskStore(path).list(), []);
  } finally {
    chmodSync(dir, mode);
  }
});

test('structurally incomplete task records are dropped on load instead of pinned forever', () => {
  const dir = freshDir();
  const path = join(dir, 'inbound-tasks.json');
  const good = new InboundTaskStore(path).handoff({ accountId: 'a', userId: 'u', messageId: '1', text: 't', refText: '' }).task;
  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  persisted.tasks.push(
    { taskId: 'a:u:2', phase: 'received', userId: 'u', messageId: '2', createdAt: 1, updatedAt: 1, history: [] },
    { taskId: 'a:u:3', phase: 'bogus' },
    { ...good, taskId: 'a:u:4', messageId: '4', phase: 'delivery-pending' },
    null,
  );
  writeFileSync(path, JSON.stringify(persisted));
  const store = new InboundTaskStore(path);
  assert.deepEqual(store.list().map((task) => task.taskId), [good.taskId]);
});

test('terminal tasks are pruned on a bounded schedule while live tasks are kept', () => {
  let now = 0;
  const store = new InboundTaskStore(undefined, {
    now: () => now,
    completedRetentionMs: 10,
    recoveryRetentionMs: 100,
    maxRetainedTasks: 3,
  });
  const make = (id: string) => store.handoff({ accountId: 'a', userId: 'u', messageId: id, text: id, refText: '' }).task.taskId;
  const done = make('done');
  store.claim(done, 'b');
  store.complete(done, 'no-agent');
  const live = make('live');
  now = 50;
  make('fresh');
  assert.equal(store.get(done), undefined, 'completed task pruned after its retention');
  assert.ok(store.get(live), 'received task is never pruned');
  for (let i = 0; i < 5; i += 1) make(`more-${i}`);
  assert.ok(store.get(live), 'live tasks survive the size cap');
});

// ─── Review follow-ups ───────────────────────────────────

test('继续 resumes owed task output that never reached the outbox instead of prompting the agent', async () => {
  const dir = freshDir();
  const proc = boot(dir, { bootId: 'boot-1' });
  const outbox = (proc.client as any).outbox;
  const original = outbox.enqueueTextBatch.bind(outbox);
  let failures = 1;
  outbox.enqueueTextBatch = (inputs: any[]) => {
    if (failures > 0 && inputs[0]?.itemId?.includes(':o0#')) {
      failures -= 1;
      throw new Error('outbox write failed');
    }
    return original(inputs);
  };
  await proc.poll([inbound(1)], 'cursor-1');
  await proc.idle();
  assert.equal(proc.client.getDeliveryStatus(UID).pending.length, 0, 'nothing queued in the outbox');
  assert.equal(proc.tasks()[0].phase, 'delivery-pending');

  await proc.poll([inbound(2, '继续')], 'cursor-2');
  await proc.idle();
  assert.equal(proc.adapterCalls.length, 1, '继续 was consumed as a delivery command');
  assert.deepEqual(proc.delivered.map((text) => text.split('\n')[0]), ['answer-1']);
  const second = proc.tasks().find((task) => task.messageId === '2');
  assert.equal(second?.phase, 'completed');
  assert.equal(second?.completion, 'no-agent');
  assert.equal(proc.tasks().find((task) => task.messageId === '1')?.phase, 'completed');
});

test('a ledger write failure after the outbox accepted an output never duplicates it in-process', async () => {
  const dir = freshDir();
  let failMark = true;
  const proc = boot(dir, {
    bootId: 'boot-1',
    faultHook: (point, task) => {
      if (point === 'before:enqueued:0' && task.messageId === '1' && failMark) {
        failMark = false;
        throw new Error('ledger write failed');
      }
    },
  });
  await proc.poll([inbound(1)], 'cursor-1');
  await proc.idle();
  assert.equal(proc.delivered.length, 1, 'the send was not blocked by the bookkeeping failure');

  await proc.poll([inbound(2, '/status')], 'cursor-2');
  await proc.idle();
  assert.equal(proc.delivered.filter((text) => text.startsWith('answer-1')).length, 1);
  assert.equal(proc.adapterCalls.length, 1);
  const task = proc.tasks().find((t) => t.messageId === '1')!;
  assert.equal(task.phase, 'completed');
  assert.equal(task.outputs?.[0].enqueued, true, 'the durable mark was retried and recorded');
});

test('/tasks does not list itself', async () => {
  const dir = freshDir();
  const proc = boot(dir, { bootId: 'boot-1' });
  await proc.poll([inbound(1, '/tasks')], 'cursor-1');
  await proc.idle();
  assert.equal(proc.delivered.at(-1), '没有未完成的任务');
});

test('the ledger stays small: completed tasks keep diagnostics, not Agent output', async () => {
  const dir = freshDir();
  const reply = 'r'.repeat(20_000);
  const proc = boot(dir, {
    bootId: 'boot-1',
    adapter: async () => ({ text: reply, duration: 1_000 }),
    clientOptions: { maxItemsPerWindow: 50 },
  });
  let writes = 0;
  const files = filesIn(dir);
  const store = proc.store as any;
  const persist = store.persist.bind(store);
  store.persist = (tasks: unknown) => { writes += 1; persist(tasks); };
  for (let i = 1; i <= 100; i += 1) {
    await proc.poll([inbound(i, `question ${i} ${'q'.repeat(2_000)}`)], `cursor-${i}`);
    await proc.idle();
  }
  assert.equal(proc.adapterCalls.length, 100);
  assert.ok(proc.tasks().every((task) => task.phase === 'completed'));
  const size = statSync(files.tasksPath).size;
  assert.ok(size < 150_000, `ledger is ${size} bytes`);
  const [task] = proc.tasks();
  assert.equal(task.outcome, undefined);
  assert.ok(task.outputs?.every((output) => output.text === '' && (output.bytes ?? 0) > 0));
  assert.ok(task.inbound.text.length <= 201);
  // handoff, claim, running, outcome+outputs, enqueued, complete
  assert.ok(writes / 100 <= 6, `${writes / 100} ledger writes per message`);
});

test('a runner error after the agent started gets an accurate recovery notice', async () => {
  const dir = freshDir();
  const proc = boot(dir, { bootId: 'boot-1' });
  const router = proc.router as any;
  const exec = router.exec.bind(router);
  router.exec = async (...args: any[]) => {
    const run = args[5];
    run.store.markRunning(run.taskId, 'boot-1', 'codex');
    throw new Error('boom');
  };
  await proc.poll([inbound(1)], 'cursor-1');
  await proc.idle();
  router.exec = exec;
  const [task] = proc.tasks();
  assert.equal(task.phase, 'recovery-required');
  assert.equal(task.recovery?.reason, 'runner-error');
  assert.match(proc.delivered.at(-1) || '', /^⚠️ 处理你的消息时桥接服务内部出错，codex 可能已开始执行/);
  assert.equal(proc.adapterCalls.length, 0);
});
