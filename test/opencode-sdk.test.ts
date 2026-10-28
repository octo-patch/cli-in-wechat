import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

import { DEFAULT_SETTINGS, type IntermediateMessage } from '../src/adapters/base.js';
import { OpenCodeAdapter } from '../src/adapters/opencode-sdk.js';
import { clearOpenCodeModelCatalogCache } from '../src/adapters/opencode-models.js';

type Call = { name: string; args: any };

interface FakeOptions {
  /** Events the server pushes once the prompt has been dispatched. */
  events?: any[];
  /** When false, `session.get` rejects the way a deleted session does. */
  sessionExists?: boolean;
  agents?: Array<{ name: string; mode?: string }>;
  /** Version `/global/health` reports; null makes the route 404 like a pre-health server. */
  healthVersion?: string | null;
  /** V2 answers `/api/info` instead of `/global/health`. */
  apiInfoVersion?: string;
  /** Raw routes (`/permission/...`, `/question/...`) that answer with a 404. */
  missingRoutes?: string[];
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
      record('permission.respond', args);
      return { data: {} };
    },
    // The generated client's transport, used for routes the root SDK entry lacks.
    _client: {
      get: async (args: any) => {
        record(`GET ${args.url}`, args);
        if (args.url === '/global/health' && options.healthVersion !== null) {
          return { data: { healthy: true, version: options.healthVersion ?? '1.19.4' } };
        }
        if (args.url === '/api/info' && options.apiInfoVersion) {
          return { data: { pid: 1, version: options.apiInfoVersion } };
        }
        throw new Error('404 Not Found');
      },
      post: async (args: any) => {
        record(`POST ${args.url}`, args);
        if (options.missingRoutes?.includes(args.url)) throw new Error('404 Not Found');
        return { data: true };
      },
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

test('sends an advertised Flash effort through the SDK and caches the verbose catalog', async (t) => {
  clearOpenCodeModelCatalogCache();
  let catalogCalls = 0;
  const model = 'minimax/MiniMax-M3.1-Flash';
  t.mock.method(childProcess, 'execSync', (command: string, options: { cwd?: string }) => {
    assert.equal(command, 'opencode models --verbose');
    assert.equal(options.cwd, '/tmp/sdk-flash');
    catalogCalls += 1;
    return `${model}\n${JSON.stringify({ variants: { high: {} } }, null, 2)}\n`;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    clearOpenCodeModelCatalogCache();
  });

  const fake = createFakeClient({ events: [IDLE] });
  const adapter = new OpenCodeAdapter(fake.factory);
  const flashSettings = settings({
    model,
    effort: 'high',
    workDir: '/tmp/sdk-flash',
    sessionIds: { opencode: 'ses_active' },
  });

  await adapter.execute('first', { settings: flashSettings });
  await adapter.execute('second', { settings: flashSettings });

  const prompts = fake.all('session.promptAsync');
  assert.deepEqual(prompts[0].body.model, { providerID: 'minimax', modelID: 'MiniMax-M3.1-Flash' });
  assert.equal(prompts[0].body.variant, 'high');
  assert.equal(prompts[1].body.variant, 'high');
  assert.equal(catalogCalls, 1);
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

  const reply = fake.find('permission.respond');
  assert.equal(reply.path.permissionID, 'perm_1');
  assert.equal(reply.body.response, 'always');
  // A legacy event means a legacy server: the 1.19 route is not tried at all.
  assert.equal(fake.names().includes('POST /permission/{requestID}/reply'), false);
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
  assert.equal(fake.find('permission.respond').body.response, 'reject');
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

function permissionAsked(id: string, extra: Record<string, unknown> = {}) {
  // 1.19 payload: no `title`, the request names a permission and the patterns it covers.
  return {
    type: 'permission.asked',
    properties: {
      id, sessionID: 'ses_active', permission: 'bash', patterns: ['rm -rf build'], metadata: {}, always: [], ...extra,
    },
  };
}

function questionAsked(id: string) {
  return {
    type: 'question.asked',
    properties: {
      id,
      sessionID: 'ses_active',
      questions: [{
        question: 'Which database?',
        header: 'DB',
        options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'file' }],
      }],
    },
  };
}

test('permission.asked is answered through the 1.19 reply route', async () => {
  const fake = createFakeClient({ events: [permissionAsked('per_1'), IDLE] });

  await new OpenCodeAdapter(fake.factory).execute('hi', {
    settings: settings({ mode: 'auto', sessionIds: { opencode: 'ses_active' } }),
  });

  // The adapter only listened for `permission.updated`, which 1.19 servers no longer
  // emit, so every request went unanswered until the one-hour timeout.
  const reply = fake.find('POST /permission/{requestID}/reply');
  assert.equal(reply.path.requestID, 'per_1');
  assert.deepEqual(reply.body, { reply: 'always' });
  assert.equal(reply.throwOnError, true);
  assert.equal(fake.names().includes('permission.respond'), false);
});

test('permission.asked falls back to the legacy route when the new one is missing', async () => {
  const fake = createFakeClient({
    events: [permissionAsked('per_1'), IDLE],
    missingRoutes: ['/permission/{requestID}/reply'],
  });

  await new OpenCodeAdapter(fake.factory).execute('hi', {
    settings: settings({ mode: 'auto', sessionIds: { opencode: 'ses_active' } }),
  });

  const legacy = fake.find('permission.respond');
  assert.equal(legacy.path.permissionID, 'per_1');
  assert.equal(legacy.path.id, 'ses_active');
  assert.equal(legacy.body.response, 'always');
});

test('a request announced under both event names is answered once', async () => {
  const fake = createFakeClient({
    events: [
      permissionAsked('per_1'),
      { type: 'permission.updated', properties: { id: 'per_1', sessionID: 'ses_active', title: 'bash' } },
      permissionAsked('per_1'),
      IDLE,
    ],
  });

  await new OpenCodeAdapter(fake.factory).execute('hi', {
    settings: settings({ mode: 'auto', sessionIds: { opencode: 'ses_active' } }),
  });

  const replies = fake.all('POST /permission/{requestID}/reply').length + fake.all('permission.respond').length;
  assert.equal(replies, 1);
});

test('non-auto mode rejects permission.asked and describes it without a title', async () => {
  const fake = createFakeClient({ events: [permissionAsked('per_1'), IDLE] });
  const activity: IntermediateMessage[] = [];

  await new OpenCodeAdapter(fake.factory).execute('hi', {
    settings: settings({ mode: 'safe', sessionIds: { opencode: 'ses_active' } }),
    onIntermediate: (msg) => activity.push(msg),
  });

  assert.deepEqual(fake.find('POST /permission/{requestID}/reply').body, { reply: 'reject' });
  const notice = activity.find((msg) => msg.content.includes('已拒绝权限请求'));
  assert.ok(notice);
  assert.ok(notice.content.includes('bash rm -rf build'));
});

test('safe mode puts permission requests to requestPermission: once, always, reject (both routes, subagents)', async () => {
  const fake = createFakeClient({
    events: [
      childCreated('ses_child', 'ses_active'),
      permissionAsked('per_once', { patterns: ['npm test'] }),
      permissionAsked('per_always', { permission: 'edit', patterns: ['src/a.ts'] }),
      permissionAsked('per_reject', { patterns: ['rm -rf /'] }),
      { type: 'permission.updated', properties: { id: 'per_legacy', sessionID: 'ses_child', title: 'webfetch example.com' } },
      IDLE,
    ],
  });
  const answers: Record<string, string> = {
    'bash npm test': 'once', 'edit src/a.ts': 'always', 'bash rm -rf /': 'reject', 'webfetch example.com': 'always',
  };
  const asked: any[] = [];
  const signals: unknown[] = [];
  const activity: IntermediateMessage[] = [];

  await new OpenCodeAdapter(fake.factory).execute('hi', {
    settings: settings({ mode: 'safe', sessionIds: { opencode: 'ses_active' } }),
    requestPermission: async (req, signal) => { asked.push(req); signals.push(signal); return answers[req.title]; },
    onIntermediate: (msg) => activity.push(msg),
  });

  assert.equal(asked.length, 4);
  assert.deepEqual(asked[0], {
    title: 'bash npm test',
    kind: 'execute',
    options: [
      { id: 'once', name: '允许一次', kind: 'allow_once' },
      { id: 'always', name: '本会话总是允许', kind: 'allow_always' },
      { id: 'reject', name: '拒绝', kind: 'reject_once' },
    ],
  });
  assert.equal(asked[1].kind, 'edit');
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  const modern = Object.fromEntries(fake.all('POST /permission/{requestID}/reply').map((r) => [r.path.requestID, r.body.reply]));
  assert.deepEqual(modern, { per_once: 'once', per_always: 'always', per_reject: 'reject' });
  const legacy = fake.find('permission.respond');
  assert.deepEqual(legacy.path, { id: 'ses_child', permissionID: 'per_legacy' });
  assert.equal(legacy.body.response, 'always');
  const notices = activity.filter((msg) => msg.content.includes('已拒绝权限请求'));
  assert.deepEqual(notices.map((msg) => msg.content), ['  ↳ 已拒绝权限请求（bash rm -rf /）']);
});

test('a throwing, timed-out, null or unknown approval is a rejection', async () => {
  const fake = createFakeClient({
    events: [permissionAsked('per_throw'), permissionAsked('per_timeout'), permissionAsked('per_null'), permissionAsked('per_odd'), IDLE],
  });
  const answers = [
    () => Promise.reject(new Error('boom')),
    () => Promise.reject(new DOMException('approval timed out', 'TimeoutError')),
    () => Promise.resolve(null),
    () => Promise.resolve('allow_please'),
  ];
  let n = 0;

  await new OpenCodeAdapter(fake.factory).execute('hi', {
    settings: settings({ mode: 'safe', sessionIds: { opencode: 'ses_active' } }),
    requestPermission: () => answers[n++](),
  });

  assert.equal(n, 4);
  const replies = fake.all('POST /permission/{requestID}/reply');
  assert.equal(replies.length, 4);
  assert.ok(replies.every((r) => r.body.reply === 'reject'));
});

test('auto and plan never call requestPermission', async () => {
  for (const [mode, reply] of [['auto', 'always'], ['plan', 'reject']] as const) {
    const fake = createFakeClient({ events: [permissionAsked('per_1'), IDLE] });
    let called = false;
    await new OpenCodeAdapter(fake.factory).execute('hi', {
      settings: settings({ mode, sessionIds: { opencode: 'ses_active' } }),
      requestPermission: async () => { called = true; return 'once'; },
    });
    assert.equal(called, false, mode);
    assert.deepEqual(fake.find('POST /permission/{requestID}/reply').body, { reply }, mode);
  }
});

test('question.asked is relayed to askUser and the answer sent back', async () => {
  const fake = createFakeClient({ events: [questionAsked('que_1'), IDLE] });
  const asked: any[] = [];

  await new OpenCodeAdapter(fake.factory).execute('hi', {
    settings: settings({ sessionIds: { opencode: 'ses_active' } }),
    askUser: async (req) => { asked.push(req); return { 'Which database?': 'SQLite' }; },
  });

  assert.deepEqual(asked, [{
    questions: [{
      question: 'Which database?',
      options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'file' }],
    }],
  }]);
  const reply = fake.find('POST /question/{requestID}/reply');
  assert.equal(reply.path.requestID, 'que_1');
  // One array of selected labels per question, in question order.
  assert.deepEqual(reply.body, { answers: [['SQLite']] });
  assert.equal(fake.names().includes('POST /question/{requestID}/reject'), false);
});

test('question.asked is rejected when nobody can answer it', async () => {
  const withoutAskUser = createFakeClient({ events: [questionAsked('que_1'), IDLE] });
  await new OpenCodeAdapter(withoutAskUser.factory).execute('hi', {
    settings: settings({ sessionIds: { opencode: 'ses_active' } }),
  });
  assert.equal(withoutAskUser.find('POST /question/{requestID}/reject').path.requestID, 'que_1');

  // The router's askUser rejects when the WeChat reply times out.
  const unanswered = createFakeClient({ events: [questionAsked('que_2'), IDLE] });
  await new OpenCodeAdapter(unanswered.factory).execute('hi', {
    settings: settings({ sessionIds: { opencode: 'ses_active' } }),
    askUser: async () => { throw new Error('回复超时'); },
  });
  assert.equal(unanswered.find('POST /question/{requestID}/reject').path.requestID, 'que_2');
});

test('an undeliverable question answer aborts the turn instead of hanging', async () => {
  // No idle event follows: the session is parked on the question.
  const fake = createFakeClient({
    events: [questionAsked('que_1')],
    missingRoutes: ['/question/{requestID}/reject'],
  });
  const started = Date.now();

  const result = await new OpenCodeAdapter(fake.factory).execute('hi', {
    settings: settings({ sessionIds: { opencode: 'ses_active' } }),
    timeout: 20_000,
  });

  assert.equal(result.error, true);
  assert.ok(result.text.includes('OpenCode 提问无法回复'));
  assert.ok(fake.names().includes('session.abort'));
  assert.ok(Date.now() - started < 5_000);
});

test('a V2 server is refused with an actionable message', async () => {
  const viaHealth = createFakeClient({ healthVersion: '2.1.4' });
  await assert.rejects(
    new OpenCodeAdapter(viaHealth.factory).execute('hi', { settings: settings() }),
    (err: Error) => err.message.includes('OpenCode V2') && err.message.includes('opencode-ai@1'),
  );
  // Nothing is sent to a server that cannot run the turn.
  assert.equal(viaHealth.names().includes('session.create'), false);
  assert.equal(viaHealth.names().includes('event.subscribe'), false);

  // V2 does not serve `/global/health`; its own probe route is `/api/info`.
  const viaInfo = createFakeClient({ healthVersion: null, apiInfoVersion: '2.0.0' });
  await assert.rejects(
    new OpenCodeAdapter(viaInfo.factory).execute('hi', { settings: settings() }),
    /OpenCode V2（2\.0\.0）/,
  );
});

function childCreated(id: string, parentID: string) {
  // 1.19 shape: `sessionID` is the child's own id, so the per-session filter alone drops it.
  return { type: 'session.created', properties: { sessionID: id, info: { id, parentID } } };
}

test('subagent permission and question requests are answered too', async () => {
  const fake = createFakeClient({
    events: [
      childCreated('ses_child', 'ses_active'),
      // Grandchild, announced the pre-1.19 way (no top-level sessionID).
      { type: 'session.created', properties: { info: { id: 'ses_grand', parentID: 'ses_child' } } },
      { ...permissionAsked('per_child'), properties: { ...permissionAsked('per_child').properties, sessionID: 'ses_child' } },
      { type: 'permission.updated', properties: { id: 'per_grand', sessionID: 'ses_grand', title: 'edit' } },
      { ...questionAsked('que_child'), properties: { ...questionAsked('que_child').properties, sessionID: 'ses_child' } },
      IDLE,
    ],
  });
  const asked: any[] = [];

  await new OpenCodeAdapter(fake.factory).execute('hi', {
    settings: settings({ mode: 'auto', sessionIds: { opencode: 'ses_active' } }),
    askUser: async (req) => { asked.push(req); return { 'Which database?': 'Postgres' }; },
  });

  // Left unanswered, a subagent's request blocks the parent turn until the timeout.
  assert.equal(fake.find('POST /permission/{requestID}/reply').path.requestID, 'per_child');
  // The legacy route is session-scoped: it must name the session that asked.
  const legacy = fake.find('permission.respond');
  assert.equal(legacy.path.permissionID, 'per_grand');
  assert.equal(legacy.path.id, 'ses_grand');
  assert.equal(asked.length, 1);
  assert.deepEqual(fake.find('POST /question/{requestID}/reply').body, { answers: [['Postgres']] });
});

test('requests and output from sessions outside the turn are ignored', async () => {
  const fake = createFakeClient({
    events: [
      ASSISTANT_TURN,
      childCreated('ses_child', 'ses_active'),
      childCreated('ses_other_child', 'ses_other'),
      { ...permissionAsked('per_other'), properties: { ...permissionAsked('per_other').properties, sessionID: 'ses_other_child' } },
      { ...permissionAsked('per_x'), properties: { ...permissionAsked('per_x').properties, sessionID: 'ses_other' } },
      // Child text/tool streams stay out of the WeChat reply.
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_child',
          part: { type: 'text', id: 'prt_c', messageID: 'msg_c', sessionID: 'ses_child', text: 'child chatter' },
        },
      },
      textPart('prt_1', 'root reply'),
      IDLE,
    ],
  });
  const activity: IntermediateMessage[] = [];

  const result = await new OpenCodeAdapter(fake.factory).execute('hi', {
    settings: settings({ mode: 'auto', sessionIds: { opencode: 'ses_active' } }),
    onIntermediate: (msg) => activity.push(msg),
  });

  // The server is shared across WeChat users: another user's requests are not ours to answer.
  assert.equal(fake.names().includes('POST /permission/{requestID}/reply'), false);
  assert.equal(fake.names().includes('permission.respond'), false);
  assert.equal(activity.some((msg) => msg.content.includes('child chatter')), false);
  assert.equal(result.text, 'root reply');
});

test('a V1 server without a version route is still used', async () => {
  const fake = createFakeClient({
    healthVersion: null,
    events: [{ type: 'session.idle', properties: { sessionID: 'ses_created' } }],
  });

  const result = await new OpenCodeAdapter(fake.factory).execute('hi', { settings: settings() });

  assert.equal(result.sessionId, 'ses_created');
  assert.ok(fake.names().includes('session.promptAsync'));
});
