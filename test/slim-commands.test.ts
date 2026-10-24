import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Router } from '../src/bridge/router.js';
import { DEFAULT_SETTINGS, type AdapterCapabilities } from '../src/adapters/base.js';
import type { BridgeConfig } from '../src/config.js';

// C3: command slimming — /set, the one-release alias table, capability-driven /help and a
// /status that only shows what the current tool uses.

const CAPS: Record<string, Partial<AdapterCapabilities>> = {
  claude: { sessionResume: true, modes: ['auto', 'safe', 'plan'], hasEffort: true, hasModel: true, hasBudget: true },
  codex: { sessionResume: true, modes: ['auto', 'safe', 'plan'], hasEffort: true, hasModel: true, hasSearch: true },
  gemini: { sessionResume: true, modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: true },
  kimi: { sessionResume: true, modes: ['auto'], hasEffort: false, hasModel: true },
  opencode: { sessionResume: true, modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: true },
  qwen: { sessionResume: false, modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: false },
};
const DISPLAY: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI', kimi: 'Kimi Code', opencode: 'OpenCode', qwen: 'Qwen Code',
};

function createRouter(tool = 'claude') {
  const names = Object.keys(CAPS);
  const executes: Record<string, (prompt: string, opts: any) => Promise<any>> = {};
  const registry = {
    isAvailable: (name: string) => names.includes(name),
    getAvailableNames: () => names,
    getNameByDisplayName: (display: string) => names.find((name) => DISPLAY[name] === display),
    getAll: () => names.map((name) => ({ name, displayName: DISPLAY[name] })),
    get: (name: string) => (CAPS[name] ? {
      name,
      displayName: DISPLAY[name],
      capabilities: CAPS[name],
      execute: (prompt: string, opts: any) => (executes[name] ?? (async () => ({ text: 'ok' })))(prompt, opts),
    } : undefined),
  };
  const messages: string[] = [];
  const ilink = {
    sendText: async (_uid: string, text: string) => { messages.push(text); },
    startTyping: async () => () => {},
    recoverPending: async () => [],
    getDeliveryStatus: () => ({ quota: { generation: 1, sentItems: 0, remainingItems: 10, maxItemsPerWindow: 10, rateBackoffUntil: 0 }, pending: [], failed: [] }),
    onMessage: () => {},
  };
  const settings: any = { ...DEFAULT_SETTINGS, sessionIds: {}, defaultTool: tool };
  const sessions = {
    get: () => settings,
    update: (_uid: string, partial: object) => Object.assign(settings, partial),
    setSession: (_uid: string, name: string, id: string) => { settings.sessionIds[name] = id; },
    clearSession: (_uid: string, name?: string) => { if (name) delete settings.sessionIds[name]; else settings.sessionIds = {}; },
  };
  const config: BridgeConfig = {
    defaultTool: 'claude', maxResponseChunkSize: 2000, cliTimeout: 300_000, typingInterval: 5000,
    allowedUsers: [], allowAllUsers: true, workDir: process.cwd(), tools: {},
  };
  const router = new Router(ilink as any, registry as any, sessions as any, config) as any;
  return {
    router,
    settings,
    messages,
    executes,
    last: () => messages.at(-1) ?? '',
    slash: (text: string) => router.handleSlash('u1', text),
  };
}

// ─── /set ────────────────────────────────────────────────

test('/set lists only the current tool\'s keys with their values', async () => {
  const claude = createRouter('claude');
  await claude.slash('/set');
  assert.match(claude.last(), /^claude 的设置:\nmsgmode = normal {2}— /);
  assert.match(claude.last(), /^turns = 100 {2}— 最大轮次$/m);
  assert.match(claude.last(), /^budget = 无限 /m);
  assert.doesNotMatch(claude.last(), /sandbox|approval|profile|include/);
  assert.match(claude.last(), /\/set all 查看所有工具$/);

  const codex = createRouter('codex');
  await codex.slash('/set');
  assert.match(codex.last(), /^sandbox = 无 /m);
  assert.match(codex.last(), /^search = OFF /m);
  assert.match(codex.last(), /^adddir = 无 /m);
  assert.doesNotMatch(codex.last(), /turns|budget|approval/);

  // A tool the table does not know (ACP preset, config agent) only gets the bridge-side keys.
  const qwen = createRouter('qwen');
  await qwen.slash('/set');
  assert.deepEqual(qwen.last().split('\n').slice(1, 3).map((line) => line.split(' ')[0]), ['msgmode', 'thoughts']);
  assert.equal(qwen.last().split('\n').filter((line) => line.includes(' = ')).length, 2);

  await qwen.slash('/set all');
  assert.match(qwen.last(), /^approval = 无 {2}— .* \(gemini\)$/m);
});

test('/set parses each value type and refuses bad input without changing anything', async () => {
  const { slash, last, settings } = createRouter('claude');
  await slash('/set turns 50');
  assert.equal(last(), 'turns → 50');
  assert.equal(settings.maxTurns, 50);
  await slash('/set turns abc');
  assert.match(last(), /^当前: turns = 50\n\/set turns <正整数>/);
  assert.equal(settings.maxTurns, 50);

  await slash('/set budget 2.5');
  assert.equal(settings.maxBudget, 2.5);
  assert.equal(last(), 'budget → $2.5');
  await slash('/set budget off');
  assert.equal(last(), 'budget → 无限');

  await slash('/set tools Bash,Read');
  assert.equal(settings.allowedTools, 'Bash,Read');
  await slash('/set system Answer in English please');
  assert.equal(settings.systemPrompt, 'Answer in English please');
  await slash('/set system off');
  assert.equal(settings.systemPrompt, '');

  await slash('/set thoughts');
  assert.equal(settings.showThoughts, true);
  await slash('/set thoughts off');
  assert.equal(settings.showThoughts, false);
  await slash('/set thoughts maybe');
  assert.match(last(), /只接受 on\/off/);

  await slash('/set msgmode simple');
  assert.equal(settings.msgMode, 'compact');
  await slash('/set msgmode loud');
  assert.match(last(), /^无效值: loud\n当前: msgmode = compact/);

  await slash('/set nope 1');
  assert.equal(last(), '未知设置: nope\n/set 查看可设项');
});

test('/set on a key the current tool ignores still stores it and says where it applies', async () => {
  const { slash, last, settings } = createRouter('claude');
  await slash('/set sandbox ro');
  assert.equal(settings.sandbox, 'read-only');
  assert.equal(last(), 'sandbox → read-only\n(当前工具 claude 不使用此项，对 codex/gemini 生效)');
});

test('verbose output plus thoughts still carries the rate-limit warning', async () => {
  const { slash, last } = createRouter('claude');
  await slash('/set thoughts on');
  await slash('/set msgmode verbose');
  assert.match(last(), /msgmode → verbose\n\n⚠️ 高频交互任务/);
});

// ─── Alias table (one release) ───────────────────────────

test('moved commands still work and point at /set', async () => {
  const { slash, last, settings } = createRouter('codex');
  await slash('/turns 30');
  assert.equal(last(), '(/turns 已改为 /set turns)\nturns → 30\n(当前工具 codex 不使用此项，对 claude 生效)');
  assert.equal(settings.maxTurns, 30);
  await slash('/sb full');
  assert.equal(settings.sandbox, 'danger-full-access');
  assert.match(last(), /^\(\/sb 已改为 \/set sandbox\)\nsandbox → danger-full-access$/);
  await slash('/search');
  assert.equal(settings.search, true);
  await slash('/msgmode compact');
  assert.equal(settings.msgMode, 'compact');
  await slash('/approval');
  // No more hard-coded "yolo": unset means "follow /mode".
  assert.match(last(), /^\(\/approval 已改为 \/set approval\)\n当前: approval = 无\n/);
});

test('removed commands answer with what to use instead and change nothing', async () => {
  const { slash, last, settings } = createRouter('claude');
  const before = JSON.stringify(settings);
  for (const [cmd, hint] of [
    ['verbose', /^\/verbose 已移除（Kimi 新版没有 --verbose）$/],
    ['thinking', /^\/thinking 已移除/],
    ['yolo', /^\/yolo 已移除，请用 \/mode auto 和 \/effort max$/],
    ['fast', /^\/fast 已移除，请用 \/effort low$/],
    ['plan make a plan', /^\/plan 已移除，请用 \/mode plan$/],
    ['session set abc', /^\/session 已移除，请用 \/resume/],
    ['continue', /^\/continue 已移除，请用 \/resume$/],
  ] as const) {
    await slash(`/${cmd}`);
    assert.match(last(), hint);
  }
  assert.equal(JSON.stringify(settings), before);
});

// ─── /help, /status, /mode ───────────────────────────────

test('/help is built from the current tool\'s capabilities', async () => {
  const claude = createRouter('claude');
  await claude.slash('/help');
  const help = claude.last();
  assert.match(help, /^=== cli-in-wechat 命令 \(当前: Claude Code\) ===/);
  for (const line of ['/model <名|default>  切模型', '/mode <auto|safe|plan>  权限', '/effort <low|med|high|xhigh|max>  深度', '/resume [编号|id]  历史会话', '/tasks [ack]  查看/确认中断的任务', '/send <路径>  发送文件到微信']) {
    assert.ok(help.includes(line), `help has ${line}`);
  }
  assert.match(help, /^\/set \[键\] \[值\] {2}其他设置 \(msgmode thoughts system turns budget tools notool bare name adddir\)$/m);
  assert.doesNotMatch(help, /\/verbose|\/thinking|\/turns|\/sandbox|\/approval|\/models/);
  assert.ok(help.split('\n').length < 35, 'help stays short');

  const kimi = createRouter('kimi');
  await kimi.slash('/help');
  assert.match(kimi.last(), /^\/mode <auto> {2}权限$/m);
  assert.doesNotMatch(kimi.last(), /\/effort/);

  const qwen = createRouter('qwen');
  await qwen.slash('/help');
  assert.doesNotMatch(qwen.last(), /\/model |\/effort|\/resume/);
  assert.match(qwen.last(), /其他设置 \(msgmode thoughts\)/);

  const opencode = createRouter('opencode');
  await opencode.slash('/help');
  assert.match(opencode.last(), /^\/models {2}查看可用模型$/m);
});

test('/status shows only what the current tool uses', async () => {
  const codex = createRouter('codex');
  codex.settings.sandbox = 'read-only';
  codex.settings.maxTurns = 7; // a Claude-only setting: not shown for codex
  codex.settings.sessionIds = { codex: '01a16c26-ec92-7150-9dcc-bbd651c1270f', claude: 'abc' };
  await codex.slash('/status');
  const status = codex.last();
  assert.match(status, /^工具: codex \(Codex CLI\)\n模式: auto\nmodel: 默认\neffort: high\n/);
  assert.match(status, /^设置: sandbox=read-only$/m);
  assert.match(status, /^会话: 01a16c26-ec9$/m);
  assert.doesNotMatch(status, /turns|budget|cliVerbose|claude:/);
  assert.match(status, /^delivery: pending=0 failed=0 sent=0\/10 remaining=10 ready$/m);

  const qwen = createRouter('qwen');
  await qwen.slash('/status');
  assert.doesNotMatch(qwen.last(), /^(model|effort|会话|设置):/m);
});

test('/mode explains what the mode means for the current tool', async () => {
  const claude = createRouter('claude');
  await claude.slash('/mode auto');
  assert.equal(claude.last(), 'AUTO = 最高权限，不询问\nclaude: bypass：跳过全部权限确认');
  await claude.slash('/mode safe');
  assert.match(claude.last(), /^SAFE = 每次敏感操作在微信里问你\n/);

  const codex = createRouter('codex');
  await codex.slash('/mode safe');
  assert.match(codex.last(), /codex: workspace-write 沙箱内自动执行/);

  const gemini = createRouter('gemini');
  gemini.settings.approvalMode = 'yolo';
  await gemini.slash('/mode plan');
  assert.match(gemini.last(), /gemini: --approval-mode plan\n\(已用 \/set approval yolo 覆盖；\/set approval off 恢复跟随 \/mode\)$/);

  const kimi = createRouter('kimi');
  await kimi.slash('/mode plan');
  assert.match(kimi.last(), /\(kimi 不支持 plan 模式\)$/);
});

// ─── /resume real ids and legacy sentinels ───────────────

test('/resume for codex stores the real thread id, not the old last sentinel', async () => {
  const { router, slash, last, settings } = createRouter('codex');
  const base = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  const day = join(base, '2026', '10', '23');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-2026-10-23T21-24-12-01a16c26-ec92-7150-9dcc-bbd651c1270f.jsonl'), '{}\n');
  writeFileSync(join(day, 'notes.jsonl'), '{}\n');
  router.listSessions = () => router.listCodexSessions(base);

  await slash('/resume');
  assert.match(last(), /^codex 历史会话 \(最近1条\):\n\n1\. 2026-10-23 21:24 codex 会话 01a16c26\n {3}01a16c26-ec92-7150-9dcc-bbd651c1270f/);
  await slash('/resume 1');
  assert.equal(settings.sessionIds.codex, '01a16c26-ec92-7150-9dcc-bbd651c1270f');
});

test('a stored legacy sentinel gets a one-time 已开新会话 notice once the adapter returns a real id', async () => {
  const { router, messages, executes, settings } = createRouter('codex');
  settings.sessionIds.codex = 'last';
  executes.codex = async () => ({ text: 'fresh answer', sessionId: 'thread-1' });

  await router.exec('u1', 'codex', 'hello');
  assert.match(messages.at(-1)!, /^\[旧版会话标记已失效，已开新会话\]\n\nfresh answer/);
  assert.equal(settings.sessionIds.codex, 'thread-1');

  await router.exec('u1', 'codex', 'again');
  assert.match(messages.at(-1)!, /^fresh answer/);
});

test('an adapter that still returns the sentinel itself gets no notice', async () => {
  const { router, messages, executes, settings } = createRouter('kimi');
  settings.sessionIds.kimi = 'continue';
  executes.kimi = async () => ({ text: 'same session', sessionId: 'continue' });
  await router.exec('u1', 'kimi', 'hello');
  assert.match(messages.at(-1)!, /^same session/);
});
