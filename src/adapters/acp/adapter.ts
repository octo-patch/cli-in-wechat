import { readFileSync } from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { log } from '../../utils/logger.js';
import type { DownloadedMedia } from '../../utils/media.js';
import type {
  CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, IntermediateMessage, ToolMode, PermissionRequest,
} from '../base.js';
import { commandExists, spawnCli, killProc, buildMediaPrompt, truncate } from '../base.js';
import { AcpClient, AcpRpcError, AcpTimeoutError, RPC_AUTH_REQUIRED, RPC_METHOD_NOT_FOUND } from './client.js';

/**
 * Generic Agent Client Protocol (ACP v1) adapter. One instance per preset
 * ({ name, command, args, … }); every ACP-capable CLI is "just config" on top of this.
 *
 * Process model (v1, deliberately simple): one agent process per message —
 *   initialize → session/load (when we hold a session id and the agent advertises
 *   `loadSession`; the history the agent replays during load is swallowed) or session/new →
 *   optional session/set_mode → session/prompt → collect session/update until the prompt
 *   returns its stopReason → close the process.
 *
 * The prompt travels over JSON-RPC, never argv, so Windows cmd.exe quoting is a non-issue.
 * We advertise no fs/terminal client capabilities: agents use their own tools.
 */

export interface AcpPreset {
  /** Short unique registry name (also the key in settings.sessionIds). */
  name: string;
  displayName: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Bridge /mode → this agent's ACP session mode id. Only set ids verified against the agent;
   *  a mapped id is applied only when the session actually advertises it. */
  modeIds?: Partial<Record<ToolMode, string>>;
}

export type AcpSpawn = typeof spawnCli;

const PROTOCOL_VERSION = 1;
/** initialize / session/new / session/load / set_mode must answer within this window. */
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** After session/load returns, keep swallowing replayed updates until the stream is idle. */
const REPLAY_IDLE_MS = 100;
const REPLAY_DRAIN_MAX_MS = 5_000;
/** After session/cancel, give the agent this long to finish the turn before killing it. */
const CANCEL_GRACE_MS = 2_000;
/** On finish: let the agent exit on stdin EOF for this long, then kill it and wait (bounded)
 *  so no agent outlives the run (Windows also keeps its cwd locked until it exits). */
const EXIT_AFTER_EOF_MS = 250;
const EXIT_AFTER_KILL_MS = 2_000;
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2_000;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic',
};

const CLIENT_INFO = { name: 'cli-in-wechat', version: readPackageVersion() };

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

interface PermissionOption { optionId: string; name: string; kind: string }
interface SessionModeState { currentModeId?: string; availableModes?: Array<{ id: string; name?: string }> }

const CANCELLED_OUTCOME = { outcome: { outcome: 'cancelled' } };

export class AcpAdapter implements CLIAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly command: string;
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: false, hasSearch: false, hasBudget: false,
  };

  constructor(readonly preset: AcpPreset, private readonly spawnAgent: AcpSpawn = spawnCli) {
    this.name = preset.name;
    this.displayName = preset.displayName;
    this.command = preset.command;
  }

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  async execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const start = Date.now();
    const { settings, signal } = opts;
    if (signal?.aborted) return { text: '已取消', error: true };
    // ACP requires an absolute cwd.
    const workDir = resolvePath(settings.workDir || opts.workDir || process.cwd());
    const args = [...this.preset.args, ...(opts.extraArgs ?? [])];
    const emit = opts.onIntermediate;

    let proc: ChildProcess;
    try {
      proc = this.spawnAgent(this.command, args, {
        cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.preset.env },
      });
    } catch (e) {
      return { text: `无法启动 ${this.displayName}: ${(e as Error).message}`, error: true };
    }

    let stderrTail = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (c: string) => { stderrTail = (stderrTail + c).slice(-STDERR_TAIL_CHARS); });
    proc.stdin?.on('error', (e) => log.debug(`[${this.name}] stdin error (ignored):`, e.message));
    let spawnError: Error | null = null;
    let hasExited = false;
    const exited = new Promise<void>((done) => {
      proc.once('close', () => { hasExited = true; done(); });
      proc.once('error', (e) => { spawnError = e; hasExited = true; done(); });
    });

    // ── Per-run state ──
    let sessionId: string | undefined;
    let replaying = false;
    let lastUpdateAt = 0;
    let cancelled = false;
    let timedOut = false;
    let safeRejections = 0;
    let streamedText = false;
    const texts: string[] = [];
    const thoughts: string[] = [];
    let seg: { kind: 'text' | 'thinking'; messageId?: string; parts: string[] } | null = null;
    const seenTools = new Map<string, { title: string; kind?: string; failed?: boolean }>();

    const send = (msg: IntermediateMessage) => {
      if (msg.type === 'text') streamedText = true;
      try { emit?.(msg); } catch (e) { log.warn(`[${this.name}] onIntermediate failed:`, (e as Error).message); }
    };
    const flushSeg = () => {
      if (!seg) return;
      const content = seg.parts.join('');
      const kind = seg.kind;
      seg = null;
      if (!content.trim()) return;
      if (kind === 'text') texts.push(content); else thoughts.push(content);
      send({ type: kind, content });
    };
    const appendChunk = (kind: 'text' | 'thinking', text: string, messageId?: string) => {
      if (seg && (seg.kind !== kind || (messageId && seg.messageId && messageId !== seg.messageId))) flushSeg();
      if (!seg) seg = { kind, messageId, parts: [] };
      seg.parts.push(text);
    };
    const onTool = (u: any) => {
      const id = String(u.toolCallId ?? '');
      let entry = seenTools.get(id);
      if (!entry) {
        const title = oneLine(u.title || '');
        // A bare status update for a call we never saw carries nothing worth showing.
        if (!title && u.sessionUpdate === 'tool_call_update') return;
        flushSeg();
        entry = { title, kind: u.kind || undefined };
        seenTools.set(id, entry);
        send({ type: 'tool_use', content: `- ${truncate(title || u.kind || 'Tool', 120)}`, toolName: u.kind || 'tool' });
      }
      if (u.status === 'failed' && !entry.failed) {
        entry.failed = true;
        flushSeg();
        send({ type: 'tool_result', content: '  ↳ Error', toolName: entry.kind || 'tool' });
      }
    };
    const onUpdate = (update: any) => {
      switch (update?.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = blockText(update.content);
          if (text) appendChunk('text', text, update.messageId ?? undefined);
          break;
        }
        case 'agent_thought_chunk': {
          const text = blockText(update.content);
          if (text) appendChunk('thinking', text, update.messageId ?? undefined);
          break;
        }
        case 'tool_call':
        case 'tool_call_update':
          onTool(update);
          break;
        default:
          // plan / available_commands_update / usage_update / current_mode_update / … are
          // not surfaced to WeChat in v1.
          break;
      }
    };

    // ── Idle timeout (reset on every inbound message; paused while waiting on the user) ──
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const pauseIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
    const resetIdle = () => {
      pauseIdle();
      if (!opts.timeout || cancelled) return;
      idleTimer = setTimeout(() => { timedOut = true; stop(); }, opts.timeout);
    };

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const abortWaiters = new Set<() => void>();
    const stop = () => {
      if (cancelled) return;
      cancelled = true;
      pauseIdle();
      for (const wake of abortWaiters) wake();
      if (sessionId && !client.closed) client.notify('session/cancel', { sessionId });
      killTimer = setTimeout(() => { client.close(new Error('cancelled')); killProc(proc); }, sessionId ? CANCEL_GRACE_MS : 0);
    };
    const untilAborted = () => new Promise<null>((done) => {
      if (cancelled) { done(null); return; }
      const wake = () => { abortWaiters.delete(wake); done(null); };
      abortWaiters.add(wake);
    });

    const handlePermission = async (params: any): Promise<unknown> => {
      const options: PermissionOption[] = Array.isArray(params?.options) ? params.options : [];
      const pick = (...kinds: string[]) => {
        for (const k of kinds) { const o = options.find((opt) => opt.kind === k); if (o) return o; }
        return undefined;
      };
      const select = (o?: PermissionOption) => (o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : CANCELLED_OUTCOME);
      if (cancelled) return CANCELLED_OUTCOME;
      if (settings.mode === 'auto') return select(pick('allow_once', 'allow_always'));
      if (settings.mode === 'plan') return select(pick('reject_once', 'reject_always'));

      // safe: delegate to the host's approval hook when wired (WeChat approvals land in a later PR).
      if (opts.requestPermission) {
        const tool = params?.toolCall ?? {};
        const req: PermissionRequest = {
          title: oneLine(tool.title || '') || seenTools.get(String(tool.toolCallId))?.title || tool.kind || 'Tool',
          kind: tool.kind || undefined,
          options: options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })),
        };
        pauseIdle();
        try {
          const chosen = await Promise.race([opts.requestPermission(req, signal), untilAborted()]);
          if (cancelled) return CANCELLED_OUTCOME;
          const opt = chosen ? options.find((o) => o.optionId === chosen) : undefined;
          return opt ? select(opt) : select(pick('reject_once', 'reject_always'));
        } catch (e) {
          log.warn(`[${this.name}] permission hook failed, rejecting:`, (e as Error).message);
          return select(pick('reject_once', 'reject_always'));
        } finally {
          resetIdle();
        }
      }
      safeRejections++;
      return select(pick('reject_once', 'reject_always'));
    };

    const client = new AcpClient(proc.stdout!, proc.stdin!, {
      onMessage: () => { if (idleTimer) resetIdle(); },
      onNotification: (method, params) => {
        if (method !== 'session/update') return;
        if (sessionId && params?.sessionId && params.sessionId !== sessionId) return;
        if (replaying) { lastUpdateAt = Date.now(); return; }
        onUpdate(params?.update);
      },
      onRequest: (method, params) => {
        if (method === 'session/request_permission') return handlePermission(params);
        // fs/* and terminal/* are not advertised in clientCapabilities; anything else is unknown.
        throw new AcpRpcError(`Method not supported by client: ${method}`, RPC_METHOD_NOT_FOUND);
      },
    });
    void exited.then(() => client.close(spawnError ?? new Error('ACP agent exited')));

    const onAbort = () => stop();
    signal?.addEventListener('abort', onAbort, { once: true });

    const fail = async (text: string, extra: Partial<ExecResult> = {}): Promise<ExecResult> => ({
      text, error: true, duration: Date.now() - start, ...extra,
    });

    try {
      const init = await client.request<any>('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: CLIENT_INFO,
      }, HANDSHAKE_TIMEOUT_MS);
      if (init?.protocolVersion !== PROTOCOL_VERSION) {
        return await fail(`${this.displayName} 使用了不兼容的 ACP 协议版本 (${init?.protocolVersion ?? '未知'})`);
      }
      const caps = init.agentCapabilities ?? {};
      const canLoad = caps.loadSession === true;

      const storedId = settings.sessionIds[this.name];
      let modes: SessionModeState | undefined;
      if (storedId && canLoad) {
        replaying = true;
        try {
          const res = await client.request<any>('session/load', { sessionId: storedId, cwd: workDir, mcpServers: [] }, HANDSHAKE_TIMEOUT_MS);
          modes = res?.modes ?? undefined;
        } catch (e) {
          if (e instanceof AcpRpcError && e.code !== RPC_AUTH_REQUIRED) {
            return await fail(`${this.displayName} 无法恢复会话: ${e.message}`, { sessionExpired: true });
          }
          throw e;
        }
        sessionId = storedId;
        await drainReplay(() => lastUpdateAt, () => cancelled);
        replaying = false;
      } else {
        const res = await client.request<any>('session/new', { cwd: workDir, mcpServers: [] }, HANDSHAKE_TIMEOUT_MS);
        if (!res?.sessionId) return await fail(`${this.displayName} 未返回 sessionId`);
        sessionId = String(res.sessionId);
        modes = res.modes ?? undefined;
      }
      if (cancelled) throw new Error('cancelled');

      const wantMode = this.preset.modeIds?.[settings.mode];
      if (wantMode && modes && modes.currentModeId !== wantMode && modes.availableModes?.some((m) => m.id === wantMode)) {
        try {
          await client.request('session/set_mode', { sessionId, modeId: wantMode }, HANDSHAKE_TIMEOUT_MS);
        } catch (e) {
          if (client.closed) throw e;
          log.warn(`[${this.name}] session/set_mode ${wantMode} failed:`, (e as Error).message);
        }
      }

      const blocks = buildPromptBlocks(prompt, opts.media, workDir, caps.promptCapabilities?.image === true);
      log.debug(`[${this.name}] session=${sessionId} mode=${settings.mode} blocks=${blocks.map((b) => b.type).join(',')}`);
      resetIdle();
      const res = await client.request<any>('session/prompt', { sessionId, prompt: blocks });
      pauseIdle();
      flushSeg();

      if (cancelled) {
        return timedOut ? await fail(this.timeoutText(opts.timeout, texts)) : await fail('已取消');
      }

      const stopReason: string = res?.stopReason ?? 'end_turn';
      let text = texts.join('\n\n').trim();
      const notices: string[] = [];
      if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') notices.push(`[已达到 ${stopReason} 上限，回答可能不完整]`);
      if (safeRejections > 0) {
        notices.push(`[安全模式：已拒绝 ${safeRejections} 次工具权限请求。微信内审批将在后续版本支持；如需放行请切到 /mode auto]`);
      }
      const notice = notices.join('\n');
      // The router only sends a footer once text has streamed, so surface notices as text too.
      if (notice && streamedText) send({ type: 'text', content: notice });
      if (!text) text = stopReason === 'refusal' ? `${this.displayName} 拒绝了这个请求` : `${this.displayName} 未返回文本`;
      if (notice) text = `${text}\n\n${notice}`;

      return {
        text,
        thinking: thoughts.length > 0 ? thoughts.join('\n\n').trim() : undefined,
        sessionId: canLoad ? sessionId : undefined,
        duration: Date.now() - start,
        error: stopReason === 'refusal' ? true : undefined,
      };
    } catch (e) {
      flushSeg();
      if (timedOut) return await fail(this.timeoutText(opts.timeout, texts));
      if (cancelled) return await fail('已取消');
      if (spawnError) return await fail(`无法启动 ${this.displayName}: ${(spawnError as Error).message}`);
      if (e instanceof AcpRpcError && e.code === RPC_AUTH_REQUIRED) {
        return await fail(`${this.displayName} 需要登录：请先在本机终端完成 ${this.command} 的登录（或配置 API Key）后重试\n${e.message}`);
      }
      if (e instanceof AcpRpcError) return await fail(`${this.displayName} 错误: ${e.message}`);
      if (e instanceof AcpTimeoutError) {
        return await fail(`${this.displayName} 启动超时（${e.method} ${Math.round(e.timeoutMs / 1000)}s 无响应），可能需要先在终端登录`);
      }
      // Process died mid-run: wait briefly for exit so stderr is complete.
      await within(exited, 1_000);
      if (spawnError) return await fail(`无法启动 ${this.displayName}: ${(spawnError as Error).message}`);
      const tail = stderrTail.trim();
      const code = proc.exitCode;
      return await fail(`${this.displayName} 进程意外退出${code !== null ? ` (exit ${code})` : ''}${tail ? `\n${truncate(tail, 800)}` : ''}`);
    } finally {
      pauseIdle();
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      client.close(new Error('ACP run finished'));
      try { proc.stdin?.end(); } catch { /* ignore */ }
      if (!hasExited) await within(exited, EXIT_AFTER_EOF_MS);
      if (!hasExited) {
        killProc(proc);
        await within(exited, EXIT_AFTER_KILL_MS);
      }
    }
  }

  private timeoutText(timeout: number | undefined, texts: string[]): string {
    const partial = texts.join('\n\n').trim();
    const secs = timeout ? Math.ceil(timeout / 1000) : 0;
    return `${partial ? `${partial}\n\n` : ''}[${this.displayName} ${secs}s 无输出，已超时终止]`;
  }
}

function blockText(content: any): string {
  return content && content.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

function oneLine(s: string): string {
  return String(s).replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Wait for `p`, but never longer than `ms` (the timer is cleared either way). */
async function within(p: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise<void>((done) => { timer = setTimeout(done, ms); })]);
  clearTimeout(timer);
}

async function drainReplay(lastUpdateAt: () => number, stopped: () => boolean): Promise<void> {
  const deadline = Date.now() + REPLAY_DRAIN_MAX_MS;
  while (!stopped() && Date.now() < deadline && Date.now() - lastUpdateAt() < REPLAY_IDLE_MS) {
    await sleep(Math.max(10, REPLAY_IDLE_MS - (Date.now() - lastUpdateAt())));
  }
}

/** Text first (with non-image attachments described via buildMediaPrompt), then images as
 *  native ACP image blocks when the agent advertises `promptCapabilities.image`. */
export function buildPromptBlocks(
  prompt: string, media: DownloadedMedia[] | undefined, workDir: string, imageSupported: boolean,
): ContentBlock[] {
  const images: ContentBlock[] = [];
  const rest: DownloadedMedia[] = [];
  for (const m of media ?? []) {
    if (imageSupported && m.type === 'image') {
      try {
        const data = readFileSync(m.path);
        if (data.length <= MAX_INLINE_IMAGE_BYTES) {
          const mimeType = m.mimeType?.startsWith('image/') ? m.mimeType : (IMAGE_MIME[extname(m.fileName || m.path).toLowerCase()] ?? 'image/jpeg');
          images.push({ type: 'image', data: data.toString('base64'), mimeType });
          continue;
        }
      } catch (e) {
        log.warn(`[acp] cannot inline image ${m.path}:`, (e as Error).message);
      }
    }
    rest.push(m);
  }
  return [{ type: 'text', text: buildMediaPrompt(prompt, rest, workDir) }, ...images];
}
