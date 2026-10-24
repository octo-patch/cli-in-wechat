import { readFileSync } from 'node:fs';
import type { CanUseTool, Options, PermissionMode, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../utils/logger.js';
import type { DownloadedMedia } from '../utils/media.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, ToolMode, UserSettings } from './base.js';
import {
  commandExists,
  spawnCli,
  setupAbort,
  setupTimeout,
  isSessionError,
  buildMediaPrompt,
  collectUtf8,
  writeStdin,
  summarizeToolUse,
  summarizeToolResult,
} from './base.js';

/** The slice of the SDK's `query()` this adapter uses. Injectable so tests can feed a
 *  scripted message stream without the real SDK or binary. */
export type ClaudeQuery = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => AsyncIterable<SDKMessage>;
export type ClaudeSpawn = typeof spawnCli;

// Imported lazily: an SDK that fails to load (missing platform binary package, broken
// install) must degrade to the CLI fallback instead of breaking the whole adapter module.
const loadSdkQuery = async (): Promise<ClaudeQuery> => (await import('@anthropic-ai/claude-agent-sdk')).query;

/** WeChat /mode → Claude permission mode, shared by the SDK and CLI paths. `auto` is Claude's
 *  classifier-approved mode (not bypassPermissions); `safe` is the standard prompting mode. */
const PERMISSION_MODES: Record<ToolMode, PermissionMode> = { auto: 'auto', safe: 'default', plan: 'plan' };
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
interface InlineImage { mediaType: ImageMediaType; data: string }
// Anthropic API per-image limit; bigger images stay as a file path in the text prompt.
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

export class ClaudeAdapter implements CLIAdapter {
  readonly name = 'claude';
  readonly displayName = 'Claude Code';
  readonly command = 'claude';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: true, hasModel: true, hasSearch: false, hasBudget: true,
  };

  constructor(
    private readonly loadQuery: () => Promise<ClaudeQuery> = loadSdkQuery,
    private readonly spawnClaude: ClaudeSpawn = spawnCli,
  ) {}

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  async execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const workDir = opts.settings.workDir || opts.workDir;
    log.debug(`[claude] workDir: ${workDir}`);
    if (opts.media && opts.media.length > 0) {
      log.debug(`[claude] media paths: ${opts.media.map(m => m.path).join(', ')}`);
    }

    // executeWithSDK only throws when the SDK never got going (import failure, missing
    // binary, crash before its first message). Once it has produced anything, tools may
    // already have run, so it returns an error result instead — retrying via the CLI
    // would execute the same task twice.
    try {
      return await this.executeWithSDK(prompt, opts, workDir);
    } catch (sdkErr) {
      log.warn(`[claude] Agent SDK failed to start, falling back to CLI: ${(sdkErr as Error).message}`);
      return this.executeWithCLI(buildMediaPrompt(prompt, opts.media, workDir), opts);
    }
  }

  // ─── Agent SDK path (supports AskUserQuestion) ────────

  private async executeWithSDK(prompt: string, opts: ExecOptions, workDir: string | undefined): Promise<ExecResult> {
    const query = await this.loadQuery();
    const { settings } = opts;
    const start = Date.now();
    const msgMode = settings.msgMode || 'compact';

    const options: Options = {
      maxTurns: settings.maxTurns,
      permissionMode: PERMISSION_MODES[settings.mode] ?? 'default',
      // Load all settings sources to get complete skills/commands list
      settingSources: ['user', 'project', 'local'],
    };

    if (EFFORTS.includes(settings.effort)) options.effort = settings.effort as Options['effort'];
    else if (settings.effort) log.warn(`[claude/sdk] 忽略无效 effort: ${settings.effort}`);
    if (settings.model) options.model = settings.model;
    if (settings.maxBudget > 0) options.maxBudgetUsd = settings.maxBudget;
    // Append to Claude Code's default prompt (the preset form) rather than replacing it.
    if (settings.systemPrompt) options.systemPrompt = { type: 'preset', preset: 'claude_code', append: settings.systemPrompt };
    if (settings.allowedTools) options.allowedTools = splitList(settings.allowedTools);
    if (settings.disallowedTools) options.disallowedTools = splitList(settings.disallowedTools);
    if (settings.addDir) options.additionalDirectories = [settings.addDir];

    // Session resume
    const sid = settings.sessionIds[this.name];
    if (sid) options.resume = sid;

    // Working directory
    if (workDir) options.cwd = workDir;

    // Timeout + cancellation for the SDK path.
    //
    // The `opts.signal?.aborted` check inside the loop below only runs when a message
    // arrives, so a query that produces nothing — e.g. a tool call blocked on an
    // interactive prompt such as `sudo` waiting for a password — hangs the loop forever.
    // The router keeps its per-user `active` lock for the whole call, so one stuck query
    // silently wedges the bridge for that user until the process restarts (observed: 8h37m).
    //
    // The CLI fallback already bounds itself via setupTimeout(); mirror that here by
    // driving the SDK's own AbortController from both the caller's signal and a timer.
    //
    // The timer measures IDLE time, not total duration: it is re-armed on every message
    // (including tool_progress / task_progress heartbeats, which are otherwise not shown),
    // so a long-but-healthy agent run is never cut off, while one that has stopped
    // producing output is aborted after `timeout` of silence. A total-duration cap would
    // be wrong here — unlike the other adapters, the SDK path is Claude's primary path
    // (the CLI is only a fallback), so capping it at cliTimeout (1 h by default) would
    // kill ordinary multi-step work. Idle is also what the message below promises.
    const sdkAbort = new AbortController();
    let abortTimer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    const pauseIdleTimeout = (): void => {
      if (abortTimer) clearTimeout(abortTimer);
      abortTimer = null;
    };
    const armIdleTimeout = (): void => {
      if (!opts.timeout || finished) return;
      pauseIdleTimeout();
      abortTimer = setTimeout(() => sdkAbort.abort(), opts.timeout);
    };
    const forwardAbort = () => sdkAbort.abort();
    opts.signal?.addEventListener('abort', forwardAbort, { once: true });
    options.abortController = sdkAbort;
    // A signal that was already aborted before we subscribed never fires the listener.
    if (opts.signal?.aborted) sdkAbort.abort();

    // Always installed, so every permission ask gets an answer the model can relay.
    // In-WeChat approval is not wired up yet, so anything the permission mode did not
    // already auto-approve is denied with a readable reason. (Previously everything was
    // allowed here, which made safe/plan behave like bypass.)
    const { askUser } = opts;
    const canUseTool: CanUseTool = async (toolName, input) => {
      if (toolName !== 'AskUserQuestion') return { behavior: 'deny', message: denyMessage(settings.mode, toolName) };
      if (!askUser) return { behavior: 'deny', message: '当前无法向用户提问，请自行判断后继续' };
      log.debug('[claude] AskUserQuestion input:', JSON.stringify(input, null, 2));
      // Waiting on the user is not the agent going idle.
      pauseIdleTimeout();
      try {
        const answers = await askUser({
          questions: (input.questions as Array<{
            question: string;
            options: Array<{ label: string; description?: string }>;
            multiSelect?: boolean;
          }>) || [],
        });
        log.debug('[claude] AskUserQuestion answers:', JSON.stringify(answers));
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      } catch (err) {
        log.error('[claude] AskUserQuestion failed:', err);
        return { behavior: 'deny', message: '用户未回复' };
      } finally {
        armIdleTimeout();
      }
    };
    options.canUseTool = canUseTool;

    // Images go to Claude natively as base64 blocks (a plain string prompt cannot carry
    // them); other files are still listed as paths in the text.
    const { images, others } = splitMedia(opts.media);
    const text = buildMediaPrompt(prompt, others, workDir);
    const sdkPrompt = images.length > 0 ? singleUserMessage(text, images) : text;

    armIdleTimeout();
    log.debug(`[claude/sdk] effort=${settings.effort} mode=${settings.mode} msgMode=${msgMode} resume=${sid || 'none'} images=${images.length} timeout=${opts.timeout ?? 'none'}`);

    let resultText = '';
    let thinking = '';
    let sessionId: string | undefined;
    let cost: number | undefined;
    let error = false;
    let received = false;
    let resultSeen = false;

    // Stream intermediate messages via callback
    const { onIntermediate } = opts;
    const streamIntermediate = msgMode !== 'compact' && onIntermediate;

    // tool_use id → tool name, so parallel tool results are labelled with their own tool.
    const toolNames = new Map<string, string>();

    try {
      for await (const msg of query({ prompt: sdkPrompt, options })) {
        received = true;
        if (opts.signal?.aborted) {
          return { text: '已取消', sessionId, error: true };
        }
        armIdleTimeout();

        if (msg.type === 'system' && msg.subtype === 'init') {
          // Known before any work happens, so a cancelled/timed-out run can still be resumed.
          sessionId = msg.session_id;
          if (options.permissionMode !== msg.permissionMode) {
            log.warn(`[claude/sdk] 请求权限模式 ${options.permissionMode}，实际为 ${msg.permissionMode}`);
          }
        }

        // Messages from inside a subagent (parent_tool_use_id set) are not forwarded: the
        // main thread's Agent/Task tool_use line and its tool_result already stand for it.
        if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
          for (const block of msg.message.content) {
            if (block.type === 'thinking' && block.thinking) {
              thinking += block.thinking;
              if (streamIntermediate) onIntermediate({ type: 'thinking', content: block.thinking });
            }
            if (block.type === 'text' && block.text) {
              if (streamIntermediate && block.text.trim()) onIntermediate({ type: 'text', content: block.text });
            }
            if (block.type === 'tool_use') {
              toolNames.set(block.id, block.name);
              if (streamIntermediate) {
                onIntermediate({ type: 'tool_use', content: summarizeToolUse(block.name || 'Tool', block.input), toolName: block.name });
              }
            }
          }
        }

        if (msg.type === 'user' && !msg.parent_tool_use_id && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type !== 'tool_result') continue;
            const toolName = toolNames.get(block.tool_use_id);
            toolNames.delete(block.tool_use_id);
            if (!streamIntermediate || !block.content) continue;
            const summary = summarizeToolResult(toolName, block.content);
            if (summary) onIntermediate({ type: 'tool_result', content: summary, toolName });
          }
        }

        if (msg.type === 'result') {
          resultSeen = true;
          sessionId = msg.session_id || sessionId;
          cost = msg.total_cost_usd;
          if (msg.subtype === 'success') {
            resultText = msg.result || '(无输出)';
            error = msg.is_error;
          } else {
            resultText = describeResultError(msg, settings);
            error = true;
          }
        }
        // tool_progress, task_*, status, rate-limit and other events only keep the idle timer alive.
      }
    } catch (err) {
      if (sdkAbort.signal.aborted) {
        if (opts.signal?.aborted) return { text: '已取消', sessionId, error: true };
        // Timed out: return a result rather than throwing, so execute() does NOT retry via
        // the CLI path — that would make the user wait a second full timeout.
        const mins = Math.round((opts.timeout ?? 0) / 60000);
        log.warn(`[claude/sdk] 空闲超时 (${opts.timeout}ms 无消息)，已中止`);
        return {
          text: `执行超时（${mins} 分钟无响应），已自动中止。\n可能是某个命令在等待输入（如 sudo 密码）。`,
          sessionId,
          duration: Date.now() - start,
          error: true,
        };
      }
      // Nothing came out of the SDK: it never started, so the CLI fallback is safe.
      if (!received) throw err;
      // query() may throw right after yielding an error result; the result already says
      // what happened. Otherwise report the failure — never re-run a task that started.
      log.warn(`[claude/sdk] 执行中出错（不回退 CLI）: ${(err as Error).message}`);
      if (!resultSeen) {
        return { text: `Claude 执行出错：${(err as Error).message}`, sessionId, cost, duration: Date.now() - start, error: true };
      }
    } finally {
      finished = true;
      pauseIdleTimeout();
      opts.signal?.removeEventListener('abort', forwardAbort);
    }

    if (!received) throw new Error('Agent SDK 未返回任何消息');

    return {
      text: resultText || '(无输出)',
      thinking: thinking || undefined,
      sessionId,
      cost,
      duration: Date.now() - start,
      error: error || !resultSeen,
      // Claude reports a stale --resume id as "No conversation found with session ID: …".
      sessionExpired: error && !!sid && (isSessionError(resultText) || /no conversation found/i.test(resultText)),
    };
  }

  // ─── CLI fallback (no AskUserQuestion) ─────────────────

  private executeWithCLI(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      // -p enables print (non-interactive) mode; prompt is passed via stdin below.
      // --max-turns is hidden from `claude --help` in 2.x but still accepted.
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];

      args.push('--permission-mode', PERMISSION_MODES[settings.mode] ?? 'default');
      if (settings.maxTurns > 0) args.push('--max-turns', String(settings.maxTurns));
      if (settings.effort) args.push('--effort', settings.effort);
      if (settings.model) args.push('--model', settings.model);
      if (settings.maxBudget > 0) args.push('--max-budget-usd', String(settings.maxBudget));
      if (settings.allowedTools) args.push('--allowedTools', settings.allowedTools);
      if (settings.disallowedTools) args.push('--disallowedTools', settings.disallowedTools);
      if (settings.systemPrompt) args.push('--append-system-prompt', settings.systemPrompt);
      if (settings.bare) args.push('--bare');
      if (settings.addDir) args.push('--add-dir', settings.addDir);
      if (settings.sessionName) args.push('--name', settings.sessionName);
      const sid = settings.sessionIds[this.name];
      if (sid) args.push('--resume', sid);
      if (opts.extraArgs) args.push(...opts.extraArgs);

      log.debug(`[claude] effort=${settings.effort} model=${settings.model || 'default'} mode=${settings.mode}`);
      log.debug(`[claude] stdin prompt length: ${prompt.length}`);

      const proc = this.spawnClaude(this.command, args, {
        cwd: settings.workDir || opts.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      // 通过 stdin 传递提示词
      writeStdin(proc, prompt);

      setupAbort(proc, opts.signal);
      const timer = setupTimeout(proc, opts.timeout);
      const collected = collectUtf8(proc);

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { resolve({ text: '已取消', error: true }); return; }

        const stdout = collected.stdout(), stderr = collected.stderr();
        let text = '';
        let thinking = '';
        let sessionId: string | undefined;
        let duration: number | undefined;
        let cost: number | undefined;
        let isErr = code !== 0;

        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'assistant' && obj.message?.content && !obj.parent_tool_use_id) {
              for (const block of obj.message.content) {
                if (block.type === 'thinking' && block.thinking) {
                  thinking += block.thinking;
                }
                if (block.type === 'text' && block.text) {
                  text += block.text;
                }
              }
            }
            if (obj.type === 'result') {
              if (!text) text = obj.result || '(无输出)';
              sessionId = obj.session_id;
              duration = obj.duration_ms;
              if (typeof obj.total_cost_usd === 'number') cost = obj.total_cost_usd;
              isErr = obj.is_error || obj.subtype !== 'success';
            }
          } catch { continue; }
        }

        if (text) {
          resolve({
            text,
            thinking: thinking || undefined,
            sessionId,
            cost,
            duration,
            error: isErr,
            sessionExpired: isErr && !!sid && isSessionError(text),
          });
        } else {
          const fallbackText = stdout.trim() || stderr.trim() || `exit ${code}`;
          resolve({ text: fallbackText, error: code !== 0, sessionExpired: code !== 0 && !!sid && isSessionError(fallbackText) });
        }
      });
      proc.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ text: `无法启动: ${err.message}`, error: true }); });
    });
  }
}

function splitList(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function denyMessage(mode: ToolMode, toolName: string): string {
  if (mode === 'plan') {
    if (toolName === 'ExitPlanMode') return 'plan 模式只出计划、不执行。请把完整计划直接作为最终回复输出给用户；用户确认后会用 /mode auto 执行。';
    return `plan 模式为只读规划，不允许执行 ${toolName}；如需执行可用 /mode auto`;
  }
  if (mode === 'auto') return `auto 模式的自动审批未放行 ${toolName}，微信内审批将在后续版本支持`;
  return `safe 模式下 ${toolName} 需要审批，微信内审批将在后续版本支持；可用 /mode auto`;
}

function describeResultError(msg: Exclude<SDKResultMessage, { subtype: 'success' }>, settings: UserSettings): string {
  if (msg.subtype === 'error_max_turns') return `已达到最大轮数（${settings.maxTurns}），任务未完成。可用 /turns 调大`;
  if (msg.subtype === 'error_max_budget_usd') return `已达到预算上限（$${settings.maxBudget}），任务已停止。可用 /budget 调整`;
  return msg.errors?.filter(Boolean).join('\n') || `执行出错（${msg.subtype}）`;
}

/** Sniff the image format from magic bytes: WeChat images usually arrive without a MIME type
 *  or a reliable extension. Only the formats the Claude API accepts are recognised. */
function sniffImageType(data: Buffer): ImageMediaType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length >= 4 && data.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Split media into images Claude can see natively and everything else (listed as paths). */
function splitMedia(media?: DownloadedMedia[]): { images: InlineImage[]; others: DownloadedMedia[] } {
  const images: InlineImage[] = [];
  const others: DownloadedMedia[] = [];
  for (const m of media ?? []) {
    if (m.type === 'image') {
      try {
        const data = readFileSync(m.path);
        const mediaType = sniffImageType(data);
        if (mediaType && data.length <= MAX_INLINE_IMAGE_BYTES) {
          images.push({ mediaType, data: data.toString('base64') });
          continue;
        }
      } catch (err) {
        log.warn(`[claude] 读取图片失败，改为路径方式: ${(err as Error).message}`);
      }
    }
    others.push(m);
  }
  return { images, others };
}

/** Streaming-input prompt carrying one user turn. The iterable ends after this message; with
 *  canUseTool set, the SDK keeps stdin open until the run's result, then closes it. */
async function* singleUserMessage(text: string, images: InlineImage[]): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } })),
        ...(text.trim() ? [{ type: 'text' as const, text }] : []),
      ],
    },
  };
}
