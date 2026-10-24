import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, type IntermediateMessage } from '../src/adapters/base.js';
import { OpenCodeAdapter } from '../src/adapters/opencode-sdk.js';

type Call = { name: string; args: any };

interface FakeOptions {
  /** Events the server pushes once the prompt has been dispatched. */
  events?: any[];
  /** When false, `session.get` rejects the way a deleted session does. */
  sessionExists?: boolean;
  agents?: Array<{ name: string; mode?: string }>;
}

function createFakeClient(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const record = (name: string, args: any) => { calls.push({ name, args }); };

  let promptDispatched: () => void = () => {};
  const promptSent = new Promise<void>((resolve) => { promptDispatched = resolve; });

  const events = options.events ?? [{ type: 'session.idle', properties: { sessionID: 'ses_active' } }];

  async function* stream() {
    // Mirror the real server: nothing is emitted until the prompt is accepted.
    await promptSent;
    for (const event of events) yield event;
  }

  let subscribeSignal: AbortSignal | undefined;

  const client = {
    event: {
      subscribe: async (args: any) => {
        record('event.subscribe', args);
        subscribeSignal = args?.signal;
        return { stream: stream() };
      },
    },
    session: {
      get: async (args: any) => {
        record('session.get', args);
        if (options.sessionExists === false) throw new Error('session not found');
        return { data: { id: args.path.id } };
      },
      create: async (args: any) => {
        record('session.create', args);
        return { data: { id: 'ses_created' } };
      },
      promptAsync: async (args: any) => {
        record('session.promptAsync', args);
        promptDispatched();
      },
      status: async (args: any) => {
        record('session.status', args);
        return { data: {} };
      },
      messages: async (args: any) => {
        record('session.messages', args);
        return { data: [] };
      },
      abort: async (args: any) => { record('session.abort', args); },
      delete: async (args: any) => { record('session.delete', args); },
      list: async () => ({ data: [] }),
    },
    app: {
      agents: async (args: any) => {
        record('app.agents', args);
        return { data: options.agents ?? [] };
      },
    },
    postSessionIdPermissionsPermissionId: async (args: any) => {
      record('permission.reply', args);
      return { data: {} };
    },
  };

  return {
    client,
    calls,
    factory: async () => client as any,
    names: () => calls.map((call) => call.name),
    find: (name: string) => calls.find((call) => call.name === name)?.args,
    all: (name: string) => calls.filter((call) => call.name === name).map((call) => call.args),
    signal: () => subscribeSignal,
  };
}

function settings(overrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
  return { ...DEFAULT_SETTINGS, mode: 'auto' as const, ...overrides };
}

function textPart(id: string, text: string) {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_active',
      part: { type: 'text', id, messageID: 'msg_1', sessionID: 'ses_active', text },
    },
  };
}

const ASSISTANT_TURN = {
  type: 'message.updated',
  properties: { sessionID: 'ses_active', info: { id: 'msg_1', role: 'assistant' } },
};
const IDLE = { type: 'session.idle', properties: { sessionID: 'ses_active' } };

test('reuses the stored session and never deletes it', async () => {
  const fake = createFakeClient({
    events: [ASSISTANT_TURN, textPart('prt_1', 'done'), IDLE],
  });
  const adapter = new OpenCodeAdapter(fake.factory);

  const result = await adapter.execute('hi', {
    settings: settings({ sessionIds: { opencode: 'ses_active' } }),
  });

  assert.equal(fake.find('session.get').path.id, 'ses_active');
  assert.equal(fake.names().includes('session.create'), false);
  assert.equal(fake.find('session.promptAsync').path.id, 'ses_active');
  // Deleting the session after every turn is what made each WeChat message context-free.
  assert.equal(fake.names().includes('session.delete'), false);
  assert.equal(result.sessionId, 'ses_active');
  assert.equal(result.text, 'done');
});

test('creates a new session when the stored one is gone', async () => {
  const fake = createFakeClient({
    sessionExists: false,
    events: [{ type: 'session.idle', properties: { sessionID: 'ses_created' } }],
  });
  const adapter = new OpenCodeAdapter(fake.factory);

  const result = await adapter.execute('hi', {
    settings: settings({ sessionIds: { opencode: 'ses_stale' } }),
  });

  assert.equal(fake.find('session.get').path.id, 'ses_stale');
  assert.equal(fake.find('session.promptAsync').path.id, 'ses_created');
  assert.equal(result.sessionId, 'ses_created');
});

test('carries the working directory on every session-scoped call', async () => {
  const fake = createFakeClient({
    events: [{ type: 'session.idle', properties: { sessionID: 'ses_created' } }],
  });
  const adapter = new OpenCodeAdapter(fake.factory);

  await adapter.execute('hi', { settings: settings({ workDir: '/tmp/work' }) });

  // Without `directory` the session runs in the server's own cwd, so /cd is ignored and
  // the media copied into workDir cannot be reached by the relative paths in the prompt.
  assert.deepEqual(fake.find('session.create').query, { directory: '/tmp/work' });
  assert.deepEqual(fake.find('session.promptAsync').query, { directory: '/tmp/work' });
  assert.equal(fake.find('session.messages').query.directory, '/tmp/work');
});

test('never sends the invented permissionMode field', async () => {
  const fake = createFakeClient({
    events: [{ type: 'session.idle', properties: { sessionID: 'ses_created' } }],
  });
  const adapter = new OpenCodeAdapter(fake.factory);

  await adapter.execute('hi', { settings: settings({ mode: 'auto' }) });

  // No such field exists on the prompt body in @opencode-ai/sdk; an `as any` cast made
  // it compile and the server dropped it, silently disabling /mode.
  assert.equal('permissionMode' in fake.find('session.promptAsync').body, false);
});

test('auto mode approves a permission request instead of stalling on it', async () => {
  const fake = createFakeClient({
    events: [
      { type: 'permission.updated', properties: { id: 'perm_1', sessionID: 'ses_active', title: 'bash' } },
      IDLE,
    ],
  });
  const adapter = new OpenCodeAdapter(fake.factory);

  await adapter.execute('hi', {
    settings: settings({ mode: 'auto', sessionIds: { opencode: 'ses_active' } }),
  });

  const reply = fake.find('permission.reply');
  assert.equal(reply.path.permissionID, 'perm_1');
  assert.equal(reply.body.response, 'always');
});

test('non-auto mode refuses a permission request and says so', async () => {
  const fake = createFakeClient({
    events: [
      { type: 'permission.updated', properties: { id: 'perm_1', sessionID: 'ses_active', title: 'rm -rf' } },
      IDLE,
    ],
  });
  const adapter = new OpenCodeAdapter(fake.factory);
  const activity: IntermediateMessage[] = [];

  await adapter.execute('hi', {
    settings: settings({ mode: 'safe', sessionIds: { opencode: 'ses_active' } }),
    onIntermediate: (msg) => activity.push(msg),
  });

  // Nobody can answer a prompt over WeChat, so an unanswered request would simply hang
  // the session until the one-hour timeout.
  assert.equal(fake.find('permission.reply').body.response, 'reject');
  assert.ok(activity.some((msg) => msg.content.includes('已拒绝权限请求')));
});

test('streams only the new suffix when a text part grows across snapshots', async () => {
  const fake = createFakeClient({
    events: [
      ASSISTANT_TURN,
      textPart('prt_1', '你好'),
      textPart('prt_1', '你好，世界'),
      IDLE,
    ],
  });
  const adapter = new OpenCodeAdapter(fake.factory);
  const activity: IntermediateMessage[] = [];

  const result = await adapter.execute('hi', {
    settings: settings({ sessionIds: { opencode: 'ses_active' } }),
    onIntermediate: (msg) => activity.push(msg),
  });

  // `message.part.updated` is a whole-part snapshot: emitting it verbatim each time sent
  // the same prefix again and again as progressively longer WeChat bubbles.
  assert.deepEqual(activity.filter((msg) => msg.type === 'text').map((msg) => msg.content), ['你好', '，世界']);
  assert.equal(result.text, '你好，世界');
});

test('drops parts belonging to the user echo', async () => {
  const fake = createFakeClient({
    events: [
      { type: 'message.updated', properties: { sessionID: 'ses_active', info: { id: 'msg_u', role: 'user' } } },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_active',
          part: { type: 'text', id: 'prt_u', messageID: 'msg_u', sessionID: 'ses_active', text: 'SEND_FILE: secret' },
        },
      },
      ASSISTANT_TURN,
      textPart('prt_1', 'reply'),
      IDLE,
    ],
  });
  const adapter = new OpenCodeAdapter(fake.factory);
  const activity: IntermediateMessage[] = [];

  const result = await adapter.execute('hi', {
    settings: settings({ sessionIds: { opencode: 'ses_active' } }),
    onIntermediate: (msg) => activity.push(msg),
  });

  assert.equal(activity.some((msg) => msg.content.includes('SEND_FILE')), false);
  assert.equal(result.text, 'reply');
});

test('closes the SSE subscription when the turn ends', async () => {
  const fake = createFakeClient({
    events: [ASSISTANT_TURN, textPart('prt_1', 'done'), IDLE],
  });
  const adapter = new OpenCodeAdapter(fake.factory);

  await adapter.execute('hi', { settings: settings({ sessionIds: { opencode: 'ses_active' } }) });

  // One leaked subscription per message otherwise: the loop only exits when a later
  // event arrives, which never happens on a quiet stream.
  assert.equal(fake.signal()?.aborted, true);
});

test('plan mode uses the plan agent only when the server publishes one', async () => {
  const withPlan = createFakeClient({
    agents: [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }],
    events: [IDLE],
  });
  await new OpenCodeAdapter(withPlan.factory).execute('hi', {
    settings: settings({ mode: 'plan', sessionIds: { opencode: 'ses_active' } }),
  });
  assert.equal(withPlan.find('session.promptAsync').body.agent, 'plan');

  const withoutPlan = createFakeClient({ agents: [{ name: 'build', mode: 'primary' }], events: [IDLE] });
  await new OpenCodeAdapter(withoutPlan.factory).execute('hi', {
    settings: settings({ mode: 'plan', sessionIds: { opencode: 'ses_active' } }),
  });
  // An unknown agent name is a 400 that would fail the whole turn.
  assert.equal('agent' in withoutPlan.find('session.promptAsync').body, false);
});

test('compact mode keeps the final text but sends no intermediate activity', async () => {
  const fake = createFakeClient({
    events: [ASSISTANT_TURN, textPart('prt_1', 'quiet'), IDLE],
  });
  const adapter = new OpenCodeAdapter(fake.factory);
  const activity: IntermediateMessage[] = [];

  const result = await adapter.execute('hi', {
    settings: settings({ sessionIds: { opencode: 'ses_active' }, msgMode: 'compact' }),
    onIntermediate: (msg) => activity.push(msg),
  });

  assert.deepEqual(activity, []);
  assert.equal(result.text, 'quiet');
});
