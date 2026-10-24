import { randomUUID } from 'node:crypto';
import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, IntermediateMessage, ToolMode } from './base.js';
import {
  commandExists, spawnCli, setupAbort, setupTimeout, stripAnsi, isSessionError, buildMediaPrompt, collectUtf8, writeStdin,
  summarizeToolUse, summarizeToolResult,
} from './base.js';

export type GeminiSpawn = typeof spawnCli;

/** Bridge /mode → `--approval-mode`. An explicit /approval (settings.approvalMode) wins. */
const APPROVAL_BY_MODE: Record<ToolMode, string> = { auto: 'yolo', safe: 'default', plan: 'plan' };

/** Gemini built-in tool names → the names summarizeToolUse/summarizeToolResult understand. */
const TOOL_ALIASES: Record<string, string> = {
  run_shell_command: 'Bash', read_file: 'Read', read_many_files: 'Read', write_file: 'Write', replace: 'Edit',
  glob: 'Glob', grep_search: 'Grep', search_file_content: 'Grep', list_directory: 'LS',
  web_fetch: 'WebFetch', google_web_search: 'WebSearch',
};

const CONFIRM_DENIED = /requires user confirmation/i;
const SAFE_MODE_NOTICE = '[Gemini 在非交互模式下无法在微信里确认工具调用，需要确认的操作（写文件、执行命令等）已被拒绝。如需执行请 /mode auto]';

interface GeminiRun {
  code: number | null;
  stdout: string;
  stderr: string;
  sawEvents: boolean;
  sawInit: boolean;
  sessionId?: string;
  /** Complete assistant text segments, split at tool calls / errors / end of stream. */
  segments: string[];
  streamedText: boolean;
  errors: string[];
  status?: string;
  duration?: number;
  confirmDenied: boolean;
  spawnError?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Map a raw Gemini error to a WeChat-readable hint; falls back to the raw text. */
function friendlyError(raw: string, model: string): string {
  if (/ModelNotFoundError|Requested entity was not found/i.test(raw)) {
    return `模型 "${model || '默认模型'}" 不存在或无访问权限。\n请用 /model 切换到一个可用的 Gemini 模型（运行 gemini 查看当前可用型号）。`;
  }
  // Check quota before auth: Gemini's 429 hint mentions "switch to another /auth method".
  if (/RESOURCE_EXHAUSTED|quota|Status: 429/i.test(raw)) {
    return 'Gemini API 配额已用尽，请稍后再试。';
  }
  if (/UNAUTHENTICATED|PERMISSION_DENIED|API[_ ]KEY|FatalAuthenticationError|Auth method|authenticat|Manual authorization/i.test(raw)) {
    return 'Gemini 认证失败。\n注意：Google 已于 2026-06-18 起停止为个人账号（免费 / Google AI Pro / Ultra）提供 Gemini CLI 服务。\n'
      + '请改用付费 GEMINI_API_KEY 或 Vertex AI（GOOGLE_GENAI_USE_VERTEXAI=true），或改用 Antigravity CLI（agy）。';
  }
  return raw;
}

export class GeminiAdapter implements CLIAdapter {
  readonly name = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly command = 'gemini';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: true, hasSearch: false, hasBudget: false,
  };

  constructor(private readonly spawnGemini: GeminiSpawn = spawnCli) {}

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  async execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const { settings } = opts;
    const workDir = settings.workDir || opts.workDir;
    const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
    const approval = settings.approvalMode || APPROVAL_BY_MODE[settings.mode] || 'yolo';
    // Prompt goes via stdin (avoids Windows cmd.exe special-character issues); non-TTY
    // stdin triggers headless mode without -p. stream-json gives JSONL events as they happen.
    const base = ['--output-format', 'stream-json', '--approval-mode', approval];
    if (settings.model) base.push('-m', settings.model);
    if (settings.includeDirs) base.push('--include-directories', settings.includeDirs);
    if (settings.extensions) base.push('-e', settings.extensions);
    if (settings.sandbox) base.push('--sandbox');
    const extra = opts.extraArgs ?? [];

    // New sessions get a bridge-chosen ID (`--session-id`, gemini-cli >= 0.41) so resume never
    // depends on output parsing; init.session_id still wins when present.
    const sid = settings.sessionIds[this.name];
    let newId: string | undefined = sid ? undefined : randomUUID();
    const sessionArgs = sid ? ['--resume', sid] : ['--session-id', newId!];

    log.debug(`[gemini] approval=${approval} model=${settings.model || 'default'} ${sid ? `resume=${sid}` : `new=${newId}`}`);
    let run = await this.run([...base, ...sessionArgs, ...extra], fullPrompt, opts);
    if (newId && !run.sawEvents && run.code !== 0 && /Unknown arguments?:.*session-id/i.test(run.stderr + run.stdout)) {
      log.warn('[gemini] 当前 CLI 不支持 --session-id（需要 >= 0.41），退回读取 init.session_id');
      newId = undefined;
      run = await this.run([...base, ...extra], fullPrompt, opts);
    }

    if (opts.signal?.aborted) return { text: '已取消', error: true };
    if (run.spawnError) return { text: `无法启动 Gemini CLI: ${run.spawnError}`, error: true };

    const error = run.code !== 0 || run.status === 'error';
    const parts = [...run.segments];
    const notices: string[] = [];
    if (error) {
      const raw = run.errors.join('\n') || stripAnsi(run.stderr.trim())
        || (run.sawEvents ? '' : stripAnsi(run.stdout.trim())) || `exit ${run.code}`;
      notices.push(friendlyError(raw, settings.model));
    }
    if (run.confirmDenied) notices.push(SAFE_MODE_NOTICE);
    // Router skips the final body once text was streamed, so trailing notices must stream too.
    if (run.streamedText) {
      for (const n of notices) opts.onIntermediate?.({ type: 'text', content: n });
    }
    parts.push(...notices);

    const errText = [...run.errors, run.stderr].join('\n');
    const sessionExpired = error && !!sid && isSessionError(errText);
    // Never echo the stored sid back on failure: the router clears an expired session and then
    // persists result.sessionId, which would resurrect the dead id. On error only a session the
    // CLI itself reported via init counts. Our pre-chosen ID is adopted only once init was seen,
    // so a startup failure (auth, bad flag) never leaves a dangling ID to resume.
    let sessionId: string | undefined;
    if (sessionExpired) sessionId = undefined;
    else if (error) sessionId = run.sessionId;
    else sessionId = run.sessionId || sid || (run.sawInit ? newId : undefined);
    return {
      text: parts.join('\n\n') || '(无输出)',
      sessionId,
      duration: run.duration,
      error,
      sessionExpired,
    };
  }

  /** Spawn gemini once and parse its stream-json stdout line by line. */
  private run(args: string[], stdinText: string, opts: ExecOptions): Promise<GeminiRun> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const emit = settings.msgMode !== 'compact' ? opts.onIntermediate : undefined;
      const state: GeminiRun = {
        code: null, stdout: '', stderr: '', sawEvents: false, sawInit: false, segments: [], streamedText: false, errors: [], confirmDenied: false,
      };
      const toolNames = new Map<string, string>();
      let pending = '';   // assistant deltas of the current segment
      let lineBuf = '';

      // Deltas are aggregated into one message per segment (until the next tool call or the
      // end of the turn) so WeChat gets paragraphs, not token fragments.
      const flushText = () => {
        const seg = pending.trim();
        pending = '';
        if (!seg) return;
        state.segments.push(seg);
        if (emit) { state.streamedText = true; emit({ type: 'text', content: seg }); }
      };
      const sink = (msg: IntermediateMessage) => emit?.(msg);

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let ev: Record<string, unknown>;
        try { ev = record(JSON.parse(line)); } catch { return; }
        const type = str(ev.type);
        if (!type) return;
        state.sawEvents = true;
        switch (type) {
          case 'init':
            state.sawInit = true;
            state.sessionId = str(ev.session_id) || state.sessionId;
            break;
          case 'message':
            if (ev.role === 'assistant') pending += str(ev.content);
            break;
          case 'tool_use': {
            flushText();
            const name = str(ev.tool_name) || 'Tool';
            if (str(ev.tool_id)) toolNames.set(str(ev.tool_id), name);
            sink({ type: 'tool_use', content: summarizeToolUse(TOOL_ALIASES[name] || name, ev.parameters), toolName: name });
            break;
          }
          case 'tool_result': {
            const name = toolNames.get(str(ev.tool_id)) || 'Tool';
            const errMsg = str(record(ev.error).message);
            if (CONFIRM_DENIED.test(errMsg)) state.confirmDenied = true;
            const summary = ev.status === 'error'
              ? summarizeToolResult(TOOL_ALIASES[name] || name, errMsg) || '  ↳ Error'
              : summarizeToolResult(TOOL_ALIASES[name] || name, ev.output);
            if (summary) sink({ type: 'tool_result', content: summary, toolName: name });
            break;
          }
          case 'error': {
            const msg = str(ev.message);
            if (CONFIRM_DENIED.test(msg)) state.confirmDenied = true;
            if (msg && ev.severity !== 'warning') { flushText(); state.errors.push(msg); }
            else if (msg) log.debug(`[gemini] warning: ${msg}`);
            break;
          }
          case 'result': {
            flushText();
            state.status = str(ev.status) || state.status;
            const errMsg = str(record(ev.error).message);
            if (errMsg && !state.errors.includes(errMsg)) state.errors.push(errMsg);
            const ms = record(ev.stats).duration_ms;
            if (typeof ms === 'number' && ms > 0) state.duration = ms;
            break;
          }
        }
      };

      const proc = this.spawnGemini(this.command, args, {
        cwd: settings.workDir || opts.workDir, stdio: ['pipe', 'pipe', 'pipe'],
        // Folder trust (on by default) otherwise downgrades yolo/plan to default or refuses
        // to run headless in an untrusted workDir. Respect an explicit user override.
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? 'true' },
      });

      log.debug(`[gemini] stdin: ${stdinText.substring(0, 200)}${stdinText.length > 200 ? '…' : ''}`);
      writeStdin(proc, stdinText);
      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      const out = collectUtf8(proc);
      proc.stdout?.on('data', (chunk: string) => {
        lineBuf += chunk;
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop() ?? '';
        for (const l of lines) handleLine(l);
      });

      let settled = false;
      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (lineBuf) handleLine(lineBuf);
        flushText();
        state.code = code;
        state.stdout = out.stdout();
        state.stderr = out.stderr();
        if (CONFIRM_DENIED.test(state.stderr)) state.confirmDenied = true;
        resolve(state);
      });
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        state.spawnError = err.message;
        resolve(state);
      });
    });
  }
}
