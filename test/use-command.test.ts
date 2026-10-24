import test from 'node:test';
import assert from 'node:assert/strict';

import { Router } from '../src/bridge/router.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import type { BridgeConfig } from '../src/config.js';
import type { WeixinMessage } from '../src/ilink/types.js';

// C2: /use <name> and the tool lists are driven by the registry, so ACP presets (#41) and
// config.json agents (#42) work without router changes. The real AdapterRegistry is used;
// extra adapters stand in for an ACP preset and a user-defined agent.

function stubAdapter(name: string, displayName: string) {
  return {
    name,
    displayName,
    command: name,
    capabilities: { sessionResume: false },
    isAvailable: async () => true,
    execute: async () => ({ text: 'ok' }),
  };
}

function createRouter() {
  const registry = new AdapterRegistry() as any;
  registry.register(stubAdapter('qwen', 'Qwen Code'));
  registry.register(stubAdapter('my-agent', 'my-agent'));
  // Installed: Claude, the OpenCode CLI fallback (SDK missing), the ACP preset and the custom agent.
  registry.available = new Set(['claude', 'opencode-cli', 'qwen', 'my-agent']);

  const messages: string[] = [];
  const ilink = {
    sendText: async (_uid: string, text: string) => { messages.push(text); },
    startTyping: async () => () => {},
    recoverPending: async () => [],
    getDeliveryStatus: () => ({ quota: { generation: 1 }, pending: [], failed: [] }),
    onMessage: () => {},
  };
  const state: any = { defaultTool: '', sessionIds: {}, mode: 'auto', effort: 'high', maxTurns: 100, maxBudget: 0, msgMode: 'normal' };
  const sessions = {
    get: () => state,
    update: (_uid: string, partial: object) => Object.assign(state, partial),
    setSession: () => {},
    clearSession: () => {},
  };
  const config: BridgeConfig = {
    defaultTool: 'claude', maxResponseChunkSize: 2000, cliTimeout: 300_000, typingInterval: 5000,
    allowedUsers: [], allowAllUsers: true, workDir: process.cwd(), tools: {},
  };
  const router = new Router(ilink as any, registry, sessions as any, config) as any;
  const execs: Array<[string, string]> = [];
  const chains: Array<[string, string]> = [];
  router.exec = async (_uid: string, tool: string, prompt: string) => { execs.push([tool, prompt]); };
  router.chain = async (_uid: string, t1: string, t2: string) => { chains.push([t1, t2]); };
  const msg = { message_id: 1, from_user_id: 'u1', to_user_id: 'bot', client_id: 'c', create_time_ms: 0, message_type: 1, message_state: 0, context_token: 'ctx', item_list: [] } as WeixinMessage;
  return {
    router,
    state,
    messages,
    execs,
    chains,
    last: () => messages.at(-1) ?? '',
    slash: (text: string) => router.handleSlash('u1', text),
    send: (text: string) => router.handle(msg, text, ''),
  };
}

test('/use without a name lists only installed tools, once each, with the current one marked', async () => {
  const { slash, last } = createRouter();
  await slash('/use');
  assert.equal(last(), [
    '可用工具 (当前: claude):',
    '▶ claude  Claude Code (/cc)',
    '   opencode  OpenCode (/oc)',
    '   qwen  Qwen Code',
    '   my-agent  my-agent',
    '',
    '/use <名字> 切换，@<名字> 单次指定',
  ].join('\n'));
  assert.doesNotMatch(last(), /codex|gemini|kimi|opencode-cli/);
});

test('/use switches to built-in, ACP preset and config agents by registry name or display name', async () => {
  const { slash, last, state } = createRouter();
  for (const [typed, expected] of [['qwen', 'qwen'], ['my-agent', 'my-agent'], ['Qwen Code', 'qwen'], ['OC', 'opencode'], ['claude', 'claude']]) {
    await slash(`/use ${typed}`);
    assert.equal(last(), `→ ${expected}`);
    assert.equal(state.defaultTool, expected);
  }
});

test('/use refuses unknown and uninstalled tools without switching', async () => {
  const { slash, last, state } = createRouter();
  state.defaultTool = 'qwen';
  await slash('/use nope');
  assert.equal(last(), '未知工具: nope\n可用: claude, opencode, qwen, my-agent');
  await slash('/use codex');
  assert.equal(last(), '"codex" 未安装或不可用\n可用: claude, opencode, qwen, my-agent');
  await slash('/cx');
  assert.match(last(), /^"codex" 未安装或不可用/);
  assert.equal(state.defaultTool, 'qwen');
});

test('the two-letter shortcuts still switch', async () => {
  const { slash, last, state } = createRouter();
  await slash('/oc');
  assert.equal(last(), '→ opencode');
  await slash('/cc');
  assert.equal(last(), '→ claude');
  assert.equal(state.defaultTool, 'claude');
});

test('@mentions and chains resolve any registry name; an uninstalled one never falls back', async () => {
  const { send, last, execs, chains } = createRouter();
  await send('@qwen hello');
  await send('@my-agent: hi there');
  assert.deepEqual(execs, [['qwen', 'hello'], ['my-agent', 'hi there']]);

  await send('@codex hello');
  assert.match(last(), /^"codex" 未安装或不可用/);
  await send('@nope hello');
  assert.equal(last(), '未知终端: @nope\n可用: claude, opencode, qwen, my-agent');
  assert.equal(execs.length, 2);

  await send('@qwen>my-agent review this');
  assert.deepEqual(chains, [['qwen', 'my-agent']]);
});

test('/help lists /use with installed tools and only the shortcuts that work here', async () => {
  const { slash, last } = createRouter();
  await slash('/help');
  assert.match(last(), /^\/use \[名字\] {2}切工具\/列出可用 \(claude opencode qwen my-agent\)$/m);
  assert.match(last(), /^\/cc \/oc {2}快捷切换$/m);
  assert.match(last(), /^@<工具名> {2}单次指定工具$/m);
  assert.doesNotMatch(last(), /\/cx|@gemini/);
});

test('/status names the current tool and lists installed tools from the registry', async () => {
  const { slash, last, state } = createRouter();
  state.defaultTool = 'qwen';
  await slash('/status');
  assert.match(last(), /^工具: qwen \(Qwen Code\)$/m);
  assert.match(last(), /^可用: claude, opencode, qwen, my-agent$/m);
});
