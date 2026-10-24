import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, IntermediateMessage } from './base.js';
import { commandExists, spawnCli, setupAbort, setupTimeout, stripAnsi, isSessionError, buildMediaPrompt, collectUtf8, summarizeToolUse, summarizeToolResult } from './base.js';

/**
 * Kimi Code CLI adapter (MoonshotAI/kimi-code, `@moonshot-ai/kimi-code` 2.x).
 *
 * Contract (checked against the 2.3.1 bundle):
 *   • non-interactive: `-p <prompt>` with the prompt on ARGV (kimi does NOT read stdin here);
 *   • `-p` implies auto-approve and CANNOT be combined with --yolo/--auto/--plan, so the
 *     bridge's /mode is a no-op for Kimi (always auto in print mode);
 *   • `--output-format stream-json`: one JSON object per line, OpenAI-message shaped, written
 *     per step (not per token):
 *       {"role":"meta","type":"system.version","version":"…"}
 *       {"role":"assistant","content":"…","tool_calls":[{"id","function":{"name","arguments"}}]}
 *       {"role":"tool","tool_call_id":"…","content":"…"}
 *       {"role":"meta","type":"session.resume_hint","session_id":"…"}      ← last line
 *       {"type":"error","code":"session.occupied","message":"…"}           ← exit code 4
 *     Thinking is not emitted in this format; tool progress / warnings go to stderr.
 *   • resume: `-S <id>` with the real id from `session.resume_hint`. `--continue` is no longer
 *     used: it picks "the most recent session in the cwd", which mixes up WeChat users sharing
 *     a workDir and, since 2.3.1's session lock, fails concurrent runs with exit 4.
 *   • `-m <model>`, `--add-dir <dir>` remain.
 *
 * The argv prompt is why this adapter uses spawnCli (not spawnProc): on Windows spawnProc runs
 * under cmd.exe (shell:true), which would mangle any prompt containing & | %VAR% " ^ ( ).
 */
export type KimiSpawn = typeof spawnCli;

/** Legacy sentinel stored by the pre-stream-json adapter (meant "pass --continue"). */
const LEGACY_CONTINUE = 'continue';
/** `PRINT_EXIT_SESSION_OCCUPIED` in kimi's print runner. */
const EXIT_SESSION_OCCUPIED = 4;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** Incremental parser for kimi's stream-json stdout. Feed complete lines; non-JSON is ignored. */
export class KimiStreamParser {
  /** Last non-empty assistant content — the answer (earlier ones are step narration). */
  text = '';
  sessionId?: string;
  errorCode?: string;
  errorMessage?: string;
  /** True once at least one JSON event was seen. */
  sawEvent = false;
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly onIntermediate?: (msg: IntermediateMessage) => void) {}

  feed(line: string): void {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try { event = record(JSON.parse(line)); } catch { return; }
    this.sawEvent = true;

    const role = str(event.role);
    const type = str(event.type);

    if (role === 'assistant') {
      const content = str(event.content);
      if (content.trim()) {
        this.text = content;
        this.onIntermediate?.({ type: 'text', content });
      }
      const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
      for (const call of calls) {
        const c = record(call);
        const fn = record(c.function);
        const toolName = str(fn.name) || 'Tool';
        const id = str(c.id);
        if (id) this.toolNames.set(id, toolName);
        this.onIntermediate?.({ type: 'tool_use', content: summarizeToolUse(toolName, parseArgs(fn.arguments)), toolName });
      }
    } else if (role === 'tool') {
      const toolName = this.toolNames.get(str(event.tool_call_id));
      const summary = summarizeToolResult(toolName, event.content);
      if (summary) this.onIntermediate?.({ type: 'tool_result', content: summary, toolName });
    } else if (type === 'session.resume_hint') {
      this.sessionId = str(event.session_id) || this.sessionId;
    } else if (type === 'error') {
      this.errorCode = str(event.code) || this.errorCode;
      this.errorMessage = str(event.message) || this.errorMessage;
    }
  }
}

/** Last few non-empty stderr lines, for an error message when stdout carried nothing usable. */
function stderrTail(stderr: string, lines = 5): string {
  return stripAnsi(stderr).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-lines).join('\n');
}

export class KimiAdapter implements CLIAdapter {
  readonly name = 'kimi';
  readonly displayName = 'Kimi Code';
  readonly command = 'kimi';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    // Only auto is reachable in print mode (`-p` forbids --yolo/--auto/--plan).
    modes: ['auto'], hasEffort: false, hasModel: true, hasSearch: false, hasBudget: false,
  };

  constructor(private readonly spawnKimi: KimiSpawn = spawnCli) {}

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const workDir = settings.workDir || opts.workDir;
      const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
      const args: string[] = [];

      // ── Session resume ──
      // Only a real id is resumable. The legacy 'continue' sentinel means "no session": start a
      // fresh one, whose real id replaces the sentinel when this run returns.
      const stored = settings.sessionIds[this.name];
      const sessionId = stored && stored !== LEGACY_CONTINUE ? stored : undefined;
      if (stored === LEGACY_CONTINUE) log.info('[kimi] 旧版会话标记 continue 已失效，开启新会话');
      if (sessionId) args.push('-S', sessionId);

      // ── Model ──
      if (settings.model) args.push('-m', settings.model);

      // ── Extra workspace directory ──
      if (settings.addDir) args.push('--add-dir', settings.addDir);

      // ── Non-interactive output format ──
      args.push('--output-format', 'stream-json');

      // ── Prompt (non-interactive) ──
      // The prompt MUST be an argv value; spawnCli guarantees it reaches kimi verbatim on
      // every platform (no cmd.exe re-parsing on Windows).
      args.push('-p', fullPrompt);

      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[kimi] model=${settings.model || 'default'} resume=${sessionId || 'new'}`);
      log.debug(`[kimi] prompt: ${fullPrompt.substring(0, 200)}${fullPrompt.length > 200 ? '…' : ''}`);

      const proc = this.spawnKimi(this.command, args, {
        cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
      });

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      const out = collectUtf8(proc);

      // Parse stdout line by line as it arrives so step-level activity streams to WeChat.
      const parser = new KimiStreamParser(settings.msgMode !== 'compact' ? opts.onIntermediate : undefined);
      let pending = '';
      proc.stdout?.on('data', (chunk: string) => {
        pending += chunk;
        let nl: number;
        while ((nl = pending.indexOf('\n')) !== -1) {
          parser.feed(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
      });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }
        parser.feed(pending);
        pending = '';

        const stderr = out.stderr();
        const failed = code !== 0 || !!parser.errorCode;

        if (code === EXIT_SESSION_OCCUPIED || parser.errorCode === 'session.occupied') {
          resolve({
            text: `Kimi 会话正被另一个 kimi 进程占用（会话锁），请等它结束后重试，或用 /new 开新会话。${parser.errorMessage ? `\n${parser.errorMessage}` : ''}`,
            sessionId,
            error: true,
          });
          return;
        }

        if (!failed && parser.text) {
          resolve({ text: parser.text, sessionId: parser.sessionId ?? sessionId });
          return;
        }
        if (!failed && parser.sessionId) {
          // Completed turn with no assistant prose (e.g. only tool calls).
          resolve({ text: '(无输出)', sessionId: parser.sessionId });
          return;
        }

        // Error path. Never surface raw stderr (thinking, warnings, version banner) as the
        // answer — only as a labelled diagnostic tail.
        const tail = stderrTail(stderr);
        const detail = parser.errorMessage || tail;
        const text = parser.text
          ? `${parser.text}${detail ? `\n\n[exit ${code}] ${detail}` : ''}`
          : `exit ${code}${detail ? `\n${detail}` : ''}`;
        const sessionText = `${parser.errorMessage ?? ''}\n${stripAnsi(stderr)}`;
        resolve({
          text,
          sessionId: parser.sessionId,
          error: true,
          sessionExpired: !!sessionId && (isSessionError(sessionText)
            || /Session ".*" was created under a different directory/.test(sessionText)),
        });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Kimi Code: ${err.message}`, error: true });
      });
    });
  }
}
