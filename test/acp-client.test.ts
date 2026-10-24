import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { AcpClient, AcpRpcError, AcpTimeoutError, RPC_METHOD_NOT_FOUND } from '../src/adapters/acp/client.js';

/** agentOut = what the agent writes (client reads); clientOut = what the client writes. */
function pair(handlers: ConstructorParameters<typeof AcpClient>[2] = {}) {
  const agentOut = new PassThrough();
  const clientOut = new PassThrough();
  const sent: any[] = [];
  let pending = '';
  clientOut.setEncoding('utf8');
  clientOut.on('data', (c: string) => {
    pending += c;
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      sent.push(JSON.parse(pending.slice(0, nl)));
      pending = pending.slice(nl + 1);
    }
  });
  const client = new AcpClient(agentOut, clientOut, handlers);
  const reply = (msg: unknown) => agentOut.write(`${JSON.stringify(msg)}\n`);
  return { client, agentOut, sent, reply };
}

const tick = () => new Promise((r) => setImmediate(r));

test('frames on \\n only: U+2028/U+2029 inside strings survive, half packets reassemble', async () => {
  const notes: any[] = [];
  const { agentOut } = pair({ onNotification: (method, params) => notes.push({ method, params }) });
  const text = 'line sep para 中文🙂';
  const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { text } })}\n`, 'utf8');
  // Split in the middle of a multibyte character and across several writes.
  const emoji = line.indexOf(Buffer.from('🙂'));
  agentOut.write(line.subarray(0, 5));
  agentOut.write(line.subarray(5, emoji + 2));
  await tick();
  assert.equal(notes.length, 0, 'no message before the newline arrives');
  agentOut.write(line.subarray(emoji + 2));
  // Two messages in one chunk, CRLF tolerated, blank and non-JSON noise lines ignored.
  agentOut.write('\r\nnot json at all\n{"jsonrpc":"2.0","method":"a","params":1}\r\n{"jsonrpc":"2.0","method":"b"}\n');
  await tick();
  assert.deepEqual(notes.map((n) => n.method), ['session/update', 'a', 'b']);
  assert.equal(notes[0].params.text, text);
});

test('correlates concurrent requests answered out of order, including errors', async () => {
  const { client, sent, reply } = pair();
  const a = client.request('one', { n: 1 });
  const b = client.request('two', { n: 2 });
  const c = client.request('three', {});
  await tick();
  assert.deepEqual(sent.map((m) => [m.jsonrpc, m.method, m.params]), [['2.0', 'one', { n: 1 }], ['2.0', 'two', { n: 2 }], ['2.0', 'three', {}]]);
  const [idA, idB, idC] = sent.map((m) => m.id);
  assert.equal(new Set([idA, idB, idC]).size, 3);
  reply({ jsonrpc: '2.0', id: idB, result: 'B' });
  reply({ jsonrpc: '2.0', id: idC, error: { code: -32002, message: 'nope', data: { x: 1 } } });
  reply({ jsonrpc: '2.0', id: idA, result: { ok: true } });
  assert.equal(await b, 'B');
  assert.deepEqual(await a, { ok: true });
  await assert.rejects(c, (e: unknown) => e instanceof AcpRpcError && e.code === -32002 && e.message === 'nope');
});

test('answers agent→client requests; unknown methods get -32601, thrown errors are mapped', async () => {
  const { sent, reply } = pair({
    onRequest: async (method, params) => {
      if (method === 'session/request_permission') return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } };
      if (method === 'boom') throw new Error('kaput');
      throw new AcpRpcError(`Method not found: ${method}`, RPC_METHOD_NOT_FOUND);
    },
  });
  reply({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { options: [{ optionId: 'ok', kind: 'allow_once' }] } });
  reply({ jsonrpc: '2.0', id: 'str-8', method: 'fs/read_text_file', params: { path: '/etc/passwd' } });
  reply({ jsonrpc: '2.0', id: 9, method: 'boom' });
  await tick(); await tick();
  const byId = new Map(sent.map((m) => [m.id, m]));
  assert.deepEqual(byId.get(7), { jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'ok' } } });
  assert.equal(byId.get('str-8').error.code, -32601);
  assert.equal(byId.get(9).error.code, -32603);
  assert.equal(byId.get(9).error.message, 'kaput');
});

test('no onRequest handler → every agent request answered with method-not-found', async () => {
  const { sent, reply } = pair();
  reply({ jsonrpc: '2.0', id: 1, method: 'terminal/create', params: {} });
  await tick();
  assert.equal(sent[0].id, 1);
  assert.equal(sent[0].error.code, -32601);
});

test('per-request timeout rejects only that request', async () => {
  const { client, sent, reply } = pair();
  const slow = client.request('slow', {}, 20);
  const fast = client.request('fast', {});
  await tick();
  reply({ jsonrpc: '2.0', id: sent[1].id, result: 1 });
  assert.equal(await fast, 1);
  await assert.rejects(slow, (e: unknown) => e instanceof AcpTimeoutError && e.method === 'slow');
  // A late answer for the timed-out id is ignored silently.
  reply({ jsonrpc: '2.0', id: sent[0].id, result: 'late' });
  await tick();
});

test('stdout end (process exit) rejects all pending requests and later requests', async () => {
  const notes: string[] = [];
  const { client, agentOut } = pair({ onNotification: (m) => notes.push(m) });
  const p1 = client.request('a', {});
  const p2 = client.request('b', {});
  // A final message with no trailing newline is still delivered before closing.
  agentOut.end('{"jsonrpc":"2.0","method":"last"}');
  await assert.rejects(p1, /closed its stdout/);
  await assert.rejects(p2, /closed its stdout/);
  assert.deepEqual(notes, ['last']);
  assert.equal(client.closed, true);
  await assert.rejects(client.request('c', {}), /closed its stdout/);
});

test('explicit close() rejects pending with the given reason and stops writing', async () => {
  const { client, sent } = pair();
  const p = client.request('x', {});
  client.close(new Error('process exited'));
  await assert.rejects(p, /process exited/);
  client.notify('session/cancel', { sessionId: 's' });
  await tick();
  assert.equal(sent.length, 1, 'nothing written after close');
});
