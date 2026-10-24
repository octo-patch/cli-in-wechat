import type { Readable, Writable } from 'node:stream';
import { log } from '../../utils/logger.js';

/**
 * Minimal JSON-RPC 2.0 client for the Agent Client Protocol (ACP v1) over stdio.
 *
 * Deliberately hand-written instead of depending on `@agentclientprotocol/sdk` (whose 2.0
 * release removed the previous API wholesale): the wire surface we need is tiny.
 *   • Framing: NDJSON — one JSON message per line, split on the '\n' BYTE only. We do our own
 *     Buffer line splitting (no readline): readline also breaks on U+2028/U+2029, which are
 *     legal unescaped inside JSON strings and would corrupt messages.
 *   • Lines that are not JSON objects are ignored (some agents print banners on stdout).
 *   • Requests are correlated by numeric id; agent→client requests go to `onRequest`
 *     (unknown methods answer -32601); notifications go to `onNotification`.
 *   • `close()` (called on stdout end / process exit) rejects every pending request.
 */

export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;
/** ACP "Authentication required". */
export const RPC_AUTH_REQUIRED = -32000;

export class AcpRpcError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

export class AcpTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`ACP request ${method} timed out after ${timeoutMs}ms`);
    this.name = 'AcpTimeoutError';
  }
}

export interface AcpClientHandlers {
  /** Agent→client notification (e.g. `session/update`). */
  onNotification?: (method: string, params: any) => void;
  /** Agent→client request. Return the result, or throw an AcpRpcError to answer with an error. */
  onRequest?: (method: string, params: any) => unknown | Promise<unknown>;
  /** Called for every inbound JSON message (used for idle timeouts). */
  onMessage?: () => void;
}

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

type RpcId = number | string;

export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private buf: Buffer = Buffer.alloc(0);
  private closedWith: Error | null = null;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly handlers: AcpClientHandlers = {},
  ) {
    input.on('data', (chunk: Buffer | string) => this.onData(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
    input.on('end', () => {
      // A final message without a trailing newline is still a message.
      if (this.buf.length > 0) { const rest = this.buf; this.buf = Buffer.alloc(0); this.handleLine(rest.toString('utf8')); }
      this.close(new Error('ACP agent closed its stdout'));
    });
    input.on('error', (e: Error) => this.close(e));
    output.on('error', (e: Error) => this.close(e));
  }

  get closed(): boolean { return this.closedWith !== null; }

  request<T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Reject all pending requests and stop sending. Idempotent; the first reason wins. */
  close(reason: Error = new Error('ACP connection closed')): void {
    if (this.closedWith) return;
    this.closedWith = reason;
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
  }

  private send(msg: Record<string, unknown>): void {
    if (this.closedWith) return;
    try {
      this.output.write(`${JSON.stringify(msg)}\n`, 'utf8');
    } catch (e) {
      this.close(e as Error);
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : chunk;
    let start = 0;
    let nl: number;
    while ((nl = this.buf.indexOf(0x0a, start)) !== -1) {
      // Decode per complete line so multibyte UTF-8 split across chunks is never mangled.
      const line = this.buf.subarray(start, nl).toString('utf8');
      start = nl + 1;
      this.handleLine(line);
    }
    this.buf = start > 0 ? this.buf.subarray(start) : this.buf;
  }

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      log.debug(`[acp] ignoring non-JSON stdout line: ${line.slice(0, 200)}`);
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    this.handlers.onMessage?.();

    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string') {
      if (hasId) void this.handleRequest(msg.id, msg.method, msg.params);
      else {
        try { this.handlers.onNotification?.(msg.method, msg.params); }
        catch (e) { log.warn(`[acp] notification handler failed (${msg.method}):`, (e as Error).message); }
      }
      return;
    }
    if (!hasId) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.error) {
      const err = msg.error as { code?: number; message?: string; data?: unknown };
      entry.reject(new AcpRpcError(err.message || `${entry.method} failed`, typeof err.code === 'number' ? err.code : RPC_INTERNAL_ERROR, err.data));
    } else {
      entry.resolve(msg.result);
    }
  }

  private async handleRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    try {
      if (!this.handlers.onRequest) throw new AcpRpcError(`Method not found: ${method}`, RPC_METHOD_NOT_FOUND);
      const result = await this.handlers.onRequest(method, params);
      this.send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (e) {
      const err = e instanceof AcpRpcError
        ? { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) }
        : { code: RPC_INTERNAL_ERROR, message: (e as Error)?.message || String(e) };
      this.send({ jsonrpc: '2.0', id, error: err });
    }
  }
}
