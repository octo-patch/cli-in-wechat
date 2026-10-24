#!/usr/bin/env node
// Scripted fake ACP agent for adapter tests. Behaviour comes from the FAKE_ACP_SCENARIO env var
// (JSON); every message received from the client is appended to FAKE_ACP_LOG (JSONL) so tests
// can assert on what the adapter sent.
//
// Scenario fields (all optional):
//   protocolVersion, loadSession, image, modes        → initialize / session responses
//   hangOn: "<method>"                                → never answer that method
//   newError / loadError / promptError: {code,message} → answer with a JSON-RPC error
//   replay: [update]          → session/update sent during session/load (before its response)
//   replayAfter: [update]     → session/update sent right after the load response
//   prompt: [step]            → steps run on session/prompt, in order:
//       {update}              send session/update
//       {permission:{toolCall,options}}  send session/request_permission and await the answer
//       {sleep: ms}           wait
//       {waitCancel: true}    wait until session/cancel arrives, then end with stopReason "cancelled"
//       {stderr: "text"}      write to stderr
//       {raw: "line"}         write a raw stdout line (e.g. non-JSON noise)
//       {exit: code}          exit the process immediately
//   stopReason                → final stopReason (default end_turn)
//   ignoreEof                 → do not exit when stdin closes
import { appendFileSync } from 'node:fs';

const scenario = JSON.parse(process.env.FAKE_ACP_SCENARIO || '{}');
const logPath = process.env.FAKE_ACP_LOG;
const SESSION = scenario.sessionId || 'sess-new-1';

let nextId = 1000;
const waiting = new Map();
let cancelWaiter = null;
let cancelled = false;

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const update = (sessionId, u) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  write({ jsonrpc: '2.0', id, method, params });
});

async function runPrompt(id, params) {
  for (const step of scenario.prompt || []) {
    if (step.update) update(params.sessionId, step.update);
    else if (step.permission) await ask('session/request_permission', { sessionId: params.sessionId, ...step.permission });
    else if (step.sleep) await sleep(step.sleep);
    else if (step.stderr) process.stderr.write(step.stderr);
    else if (step.raw !== undefined) process.stdout.write(`${step.raw}\n`);
    else if (step.exit !== undefined) process.exit(step.exit);
    else if (step.waitCancel) {
      if (!cancelled) await new Promise((r) => { cancelWaiter = r; });
      write({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
      return;
    }
  }
  if (scenario.promptError) { write({ jsonrpc: '2.0', id, error: scenario.promptError }); return; }
  write({ jsonrpc: '2.0', id, result: { stopReason: scenario.stopReason || 'end_turn' } });
}

async function handle(msg) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(msg)}\n`);
  if (msg.method === undefined && msg.id !== undefined) {
    const resolve = waiting.get(msg.id);
    if (resolve) { waiting.delete(msg.id); resolve(msg); }
    return;
  }
  if (msg.method === 'session/cancel') {
    cancelled = true;
    if (cancelWaiter) { cancelWaiter(); cancelWaiter = null; }
    return;
  }
  if (msg.method === scenario.hangOn) return;
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      write({ jsonrpc: '2.0', id, result: {
        protocolVersion: scenario.protocolVersion ?? 1,
        agentCapabilities: { loadSession: !!scenario.loadSession, promptCapabilities: { image: !!scenario.image } },
        authMethods: [],
      } });
      break;
    case 'session/new':
      if (scenario.newError) { write({ jsonrpc: '2.0', id, error: scenario.newError }); break; }
      update(SESSION, { sessionUpdate: 'available_commands_update', availableCommands: [] });
      write({ jsonrpc: '2.0', id, result: { sessionId: SESSION, modes: scenario.modes ?? null } });
      break;
    case 'session/load':
      if (scenario.loadError) { write({ jsonrpc: '2.0', id, error: scenario.loadError }); break; }
      for (const u of scenario.replay || []) update(params.sessionId, u);
      write({ jsonrpc: '2.0', id, result: { modes: scenario.modes ?? null } });
      for (const u of scenario.replayAfter || []) update(params.sessionId, u);
      break;
    case 'session/set_mode':
      write({ jsonrpc: '2.0', id, result: {} });
      break;
    case 'session/prompt':
      void runPrompt(id, params);
      break;
    default:
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown ${method}` } });
  }
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let nl;
  while ((nl = buf.indexOf(0x0a)) !== -1) {
    const line = buf.subarray(0, nl).toString('utf8').trim();
    buf = buf.subarray(nl + 1);
    if (line) void handle(JSON.parse(line));
  }
});
// ignoreEof: keep running after stdin closes, so the client has to kill us.
if (scenario.ignoreEof) setInterval(() => {}, 1_000);
process.stdin.on('end', () => { if (!scenario.ignoreEof) process.exit(0); });
