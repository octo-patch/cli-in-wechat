import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, IntermediateMessage, UserSettings } from './base.js';
import {
  commandExists, spawnCli, setupAbort, setupTimeout, stripAnsi, isSessionError, buildMediaPrompt,
  collectUtf8, writeStdin, summarizeToolUse, summarizeToolResult, basenameFromPath, truncate,
} from './base.js';

export type CodexSpawn = typeof spawnCli;

// ─── `codex exec --json` event types (subset of @openai/codex-sdk index.d.ts) ───
type CodexItem =
  | { id: string; type: 'agent_message'; text: string }
  | { id: string; type: 'reasoning'; text: string }
  | { id: string; type: 'command_execution'; command: string; aggregated_output?: string; exit_code?: number; status?: string }
  | { id: string; type: 'file_change'; changes?: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>; status?: string }
  | { id: string; type: 'mcp_tool_call'; server: string; tool: string; arguments?: unknown; error?: { message: string }; status?: string }
  | { id: string; type: 'web_search'; query: string }
  | { id: string; type: 'todo_list'; items?: Array<{ text: string; completed: boolean }> }
  | { id: string; type: 'error'; message: string };

type CodexEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage?: Record<string, number> }
  | { type: 'turn.failed'; error?: { message?: string } }
  | { type: 'item.started' | 'item.updated' | 'item.completed'; item: CodexItem }
  | { type: 'error'; message?: string };

/** Legacy sentinel stored by the old `exec resume --last` adapter (and by /resume for codex).
 *  `--last` picks the newest session in the cwd, which leaks across users sharing a workDir,
 *  so it is treated as "no session" and a fresh thread is started. */
const LEGACY_LAST = 'last';

/** Bridge effort aliases → codex `model_reasoning_effort` (0.153 enum: none|minimal|low|medium|
 *  high|xhigh|max|ultra|persistent; current models accept low..max). Unknown values are dropped. */
const EFFORT_MAP: Record<string, string> = {
  min: 'low', minimal: 'low', low: 'low',
  med: 'medium', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'ultra',
};

export function mapCodexEffort(effort: string): string | undefined {
  return EFFORT_MAP[effort.trim().toLowerCase()];
}

/** Build argv. Following @openai/codex-sdk, every option sits at the `exec` level BEFORE
 *  `resume <id>` (resume's own parser lacks --sandbox/--profile/--add-dir) and images go last.
 *  The prompt is not on argv: codex reads it from stdin when no positional prompt is given. */
export function buildCodexArgs(settings: UserSettings, sessionId: string | undefined, images: string[] = [], extraArgs: string[] = []): string[] {
  const args = ['exec', '--json'];

  // Mode / sandbox. exec has no approval channel, so sandboxed runs use approval_policy=never
  // (commands inside the sandbox run, anything needing escalation fails instead of hanging).
  if (settings.sandbox) {
    args.push('--sandbox', settings.sandbox);
  } else if (settings.mode === 'auto') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', settings.mode === 'plan' ? 'read-only' : 'workspace-write');
  }
  if (!args.includes('--dangerously-bypass-approvals-and-sandbox')) args.push('-c', 'approval_policy="never"');

  args.push('--skip-git-repo-check');
  if (settings.model) args.push('-m', settings.model);
  if (settings.profile) args.push('--profile', settings.profile);
  if (settings.addDir) args.push('--add-dir', settings.addDir);
  if (settings.ephemeral) args.push('--ephemeral');

  const effort = settings.effort ? mapCodexEffort(settings.effort) : undefined;
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);

  // Web search is a top-level config key (`web_search = "cached"|"live"|"disabled"`).
  if (settings.search) args.push('-c', 'web_search="live"');

  args.push(...extraArgs);

  if (sessionId) args.push('resume', sessionId);
  for (const image of images) args.push('--image', image);
  return args;
}

export interface CodexParseState {
  sessionId?: string;
  text: string;
  thinking: string;
  error: boolean;
  errorText: string;
  usage?: Record<string, number>;
}

/** Incremental JSONL parser: feed lines as they arrive, read state at the end. Every completed
 *  agent message is streamed as `text` right away (the router then only sends a footer); the
 *  last one is also returned as the final answer for compact mode / non-streaming callers. */
export function createCodexParser(onIntermediate?: (msg: IntermediateMessage) => void) {
  const state: CodexParseState = { text: '', thinking: '', error: false, errorText: '' };
  const seen = new Set<string>();
  let lastText = '';
  let lastTodo = '';

  const emit = (msg: IntermediateMessage) => { if (onIntermediate && msg.content) onIntermediate(msg); };
  const fail = (message: string | undefined) => {
    state.error = true;
    if (message && !state.errorText.includes(message)) state.errorText = state.errorText ? `${state.errorText}\n${message}` : message;
  };

  const onItem = (phase: 'started' | 'updated' | 'completed', item: CodexItem) => {
    const done = phase === 'completed';
    switch (item.type) {
      case 'agent_message':
        if (!done || !item.text) return;
        lastText = item.text;
        emit({ type: 'text', content: item.text });
        return;
      case 'reasoning':
        if (!done || !item.text?.trim()) return;
        state.thinking += (state.thinking ? '\n\n' : '') + item.text.trim();
        emit({ type: 'thinking', content: item.text.trim() });
        return;
      case 'error':
        // Non-fatal (e.g. hook/config warnings); real failures arrive as turn.failed/error.
        log.warn(`[codex] ${item.message}`);
        return;
    }

    switch (item.type) {
      case 'command_execution': {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          emit({ type: 'tool_use', toolName: 'Bash', content: summarizeToolUse('Bash', { command: item.command }) });
        }
        if (done && item.exit_code !== undefined) {
          emit({ type: 'tool_result', toolName: 'Bash', content: summarizeToolResult('bash', `Exit code ${item.exit_code}`) });
        }
        return;
      }
      case 'mcp_tool_call': {
        const name = `${item.server}.${item.tool}`;
        if (!seen.has(item.id)) {
          seen.add(item.id);
          emit({ type: 'tool_use', toolName: name, content: summarizeToolUse(name, item.arguments) });
        }
        if (done && (item.error || item.status === 'failed')) {
          emit({ type: 'tool_result', toolName: name, content: `  ↳ Error: ${truncate(item.error?.message || 'failed', 80)}` });
        }
        return;
      }
      case 'file_change': {
        if (!done || seen.has(item.id)) return;
        seen.add(item.id);
        const lines = (item.changes || []).map((c) =>
          c.kind === 'delete' ? `- Delete File: \`${basenameFromPath(c.path)}\``
            : summarizeToolUse(c.kind === 'add' ? 'Write' : 'Edit', { path: c.path }));
        emit({ type: 'tool_use', toolName: 'Edit', content: lines.join('\n') || '- Edit File' });
        if (item.status === 'failed') emit({ type: 'tool_result', toolName: 'Edit', content: '  ↳ Failed' });
        return;
      }
      case 'web_search': {
        if (!done || seen.has(item.id)) return;
        seen.add(item.id);
        emit({ type: 'tool_use', toolName: 'WebSearch', content: summarizeToolUse('WebSearch', { query: item.query }) });
        return;
      }
      case 'todo_list': {
        const items = item.items || [];
        const summary = `- TodoWrite: ${items.filter((t) => t.completed).length}/${items.length}`;
        if (items.length && summary !== lastTodo) {
          lastTodo = summary;
          emit({ type: 'tool_use', toolName: 'TodoWrite', content: summary });
        }
        return;
      }
    }
  };

  const feed = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let ev: CodexEvent;
    try { ev = JSON.parse(trimmed) as CodexEvent; } catch { log.debug(`[codex] non-JSON line: ${trimmed.substring(0, 200)}`); return; }
    switch (ev.type) {
      case 'thread.started': state.sessionId = ev.thread_id; break;
      case 'turn.completed': state.usage = ev.usage; break;
      case 'turn.failed': fail(ev.error?.message || 'turn failed'); break;
      case 'error': fail(ev.message || 'stream error'); break;
      case 'item.started': case 'item.updated': case 'item.completed':
        if (ev.item) onItem(ev.type.slice(5) as 'started' | 'updated' | 'completed', ev.item);
        break;
    }
  };

  const finish = (): CodexParseState => {
    state.text = lastText;
    return state;
  };

  return { feed, finish };
}

const CODEX_SESSION_ERROR = /no saved session found|(thread|rollout|conversation).{0,20}not found/i;

export class CodexAdapter implements CLIAdapter {
  readonly name = 'codex';
  readonly displayName = 'Codex CLI';
  readonly command = 'codex';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: true, hasModel: true, hasSearch: true, hasBudget: false,
  };

  constructor(private readonly spawnCodex: CodexSpawn = spawnCli) {}

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const workDir = settings.workDir || opts.workDir;
      const media = opts.media || [];
      const images = media.filter((m) => m.type === 'image').map((m) => m.path);
      const fullPrompt = buildMediaPrompt(prompt, media.filter((m) => m.type !== 'image'), workDir);
      const stored = settings.sessionIds[this.name];
      const sessionId = stored && stored !== LEGACY_LAST ? stored : undefined;
      const args = buildCodexArgs(settings, sessionId, images, opts.extraArgs);

      log.debug(`[codex] mode=${settings.mode} sandbox=${settings.sandbox || '-'} effort=${settings.effort} search=${settings.search} resume=${sessionId || 'none'}`);
      const proc = this.spawnCodex(this.command, args, {
        cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
      });

      // Pass prompt via stdin to avoid Windows cmd.exe Unicode encoding issues
      log.debug(`[codex] stdin: ${fullPrompt.substring(0, 200)}${fullPrompt.length > 200 ? '…' : ''}`);
      writeStdin(proc, fullPrompt);

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      const out = collectUtf8(proc);
      const parser = createCodexParser(settings.msgMode !== 'compact' ? opts.onIntermediate : undefined);
      let buf = '';
      proc.stdout?.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) parser.feed(line);
      });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (buf) { parser.feed(buf); buf = ''; }
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }
        const r = parser.finish();
        if (r.usage) log.debug(`[codex] usage: ${JSON.stringify(r.usage)}`);

        const stderr = stripAnsi(out.stderr().trim());
        const error = r.error || code !== 0;
        const detail = [r.errorText, stderr].filter(Boolean).join('\n');
        const sessionExpired = error && !!sessionId && !r.sessionId
          && (CODEX_SESSION_ERROR.test(detail) || isSessionError(detail));
        let text = r.text;
        if (error && !text) {
          text = `Codex 出错: ${r.errorText || truncate(stderr, 1500) || `exit ${code}`}`;
        }
        resolve({
          text: text || `exit ${code}`,
          thinking: r.thinking || undefined,
          sessionId: sessionExpired || settings.ephemeral ? undefined : r.sessionId,
          error,
          sessionExpired,
        });
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: `无法启动 Codex CLI: ${err.message}`, error: true });
      });
    });
  }
}
