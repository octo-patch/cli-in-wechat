import { readFileSync } from 'node:fs';
import { log } from '../utils/logger.js';
import type { DownloadedMedia } from '../utils/media.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, PermissionRequest, ToolMode, UserSettings } from './base.js';
import {
  commandExists,
  spawnCli,
  killProc,
  isSessionError,
  buildMediaPrompt,
  summarizeToolUse,
  summarizeToolResult,
} from './base.js';

// Claude Code is driven directly over its bidirectional stream-json protocol — the same one
// @anthropic-ai/claude-agent-sdk speaks (wire formats below follow its 0.3.310 sdk.mjs):
//   stdin  ← {type:'user', message, parent_tool_use_id:null, session_id:''}
//            {type:'control_request', request_id, request:{subtype:'initialize'|'interrupt'}}
//            {type:'control_response', response:{subtype:'success', request_id, response}}
//   stdout → JSONL SDK messages (system/init, assistant, user, result, tool_progress, …)
//            plus control_request {subtype:'can_use_tool'} because of --permission-prompt-tool stdio.
// One execute() = one spawn; there is no second execution path to fall back to.

export type ClaudeSpawn = typeof spawnCli;

/** WeChat /mode → permission flags. `auto` is full bypass (the bridge's long-standing meaning);
 *  `safe` is the standard prompting mode; `plan` is the CLI's read-only planning mode. */
const PERMISSION_ARGS: Record<ToolMode, string[]> = {
  auto: ['--dangerously-skip-permissions'],
  safe: ['--permission-mode', 'default'],
  plan: ['--permission-mode', 'plan'],
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// After an interrupt, give the CLI this long to wind the turn down before killing it.
const INTERRUPT_GRACE_MS = 5000;

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
interface InlineImage { mediaType: ImageMediaType; data: string }
// Anthropic API per-image limit; bigger images stay as a file path in the text prompt.
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/** A `can_use_tool` control request from the CLI (fields as sent on the wire). */
export interface CanUseToolRequest {
  subtype: 'can_use_tool';
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  /** Rules that would stop the CLI asking again this session ("always allow"). */
  permission_suggestions?: unknown[];
  /** Set when an "always allow" rule would grant more than this ask: offer no persistent option. */
  suppress_always_allow_rule?: boolean;
  title?: string;
  description?: string;
  decision_reason?: string;
  [key: string]: unknown;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

/**
 * The single decision point for every permission ask the CLI hands back to us — anything
 * the permission mode did not settle itself. AskUserQuestion is answered through WeChat (the
 * CLI routes it here in every mode, bypass included, because the tool requires user
 * interaction). In auto (bypass) anything else that still asks is allowed, matching bypass.
 * In safe, the ask goes to the user through `requestPermission` (allow once / always allow
 * via `permission_suggestions` → `updatedPermissions` / reject); without that hook it is denied
 * with a readable reason, never silently allowed. Plan mode stays read-only: the CLI enforces
 * it and every write that asks is denied here, without asking anyone.
 */
export async function decidePermission(
  req: CanUseToolRequest,
  ctx: {
    mode: ToolMode;
    askUser?: ExecOptions['askUser'];
    requestPermission?: ExecOptions['requestPermission'];
    signal?: AbortSignal;
  },
): Promise<PermissionDecision> {
  const input = req.input ?? {};
  if (req.tool_name !== 'AskUserQuestion') {
    if (ctx.mode === 'auto') return { behavior: 'allow', updatedInput: input };
    if (ctx.mode === 'safe' && ctx.requestPermission) return askApproval(req, input, ctx.requestPermission, ctx.signal);
    return { behavior: 'deny', message: denyMessage(ctx.mode, req.tool_name) };
  }
  if (!ctx.askUser) return { behavior: 'deny', message: '当前无法向用户提问，请自行判断后继续' };
  log.debug('[claude] AskUserQuestion input:', JSON.stringify(input, null, 2));
  try {
    const answers = await ctx.askUser({
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
  }
}

/** Safe-mode approval through the bridge. A throw, a timeout on the bridge side (null) or an
 *  unknown option id all count as a rejection. */
async function askApproval(
  req: CanUseToolRequest,
  input: Record<string, unknown>,
  requestPermission: NonNullable<ExecOptions['requestPermission']>,
  signal?: AbortSignal,
): Promise<PermissionDecision> {
  const suggestions = !req.suppress_always_allow_rule && Array.isArray(req.permission_suggestions)
    ? req.permission_suggestions : [];
  const options: PermissionRequest['options'] = [{ id: 'allow_once', name: '允许一次', kind: 'allow_once' }];
  if (suggestions.length) options.push({ id: 'allow_always', name: '总是允许', kind: 'allow_always' });
  options.push({ id: 'reject_once', name: '拒绝', kind: 'reject_once' });
  const summary = summarizeToolUse(req.tool_name, input).replace(/^- /, '');
  const title = req.description ? `${summary} — ${req.description.slice(0, 200)}` : summary;

  let choice: string | null = null;
  try {
    choice = await requestPermission({ title, kind: toolKind(req.tool_name), options }, signal);
  } catch (err) {
    log.warn(`[claude] 审批 ${req.tool_name} 失败，按拒绝处理:`, (err as Error).message);
  }
  if (choice === 'allow_once') return { behavior: 'allow', updatedInput: input };
  if (choice === 'allow_always' && suggestions.length) {
    return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions };
  }
  return { behavior: 'deny', message: `用户拒绝了 ${req.tool_name}` };
}

/** ACP-style tool kind for the approval prompt, when the tool maps onto one. */
function toolKind(toolName: string): string | undefined {
  if (/^bash$/i.test(toolName)) return 'execute';
  if (/^(edit|multiedit|write|notebookedit)$/i.test(toolName)) return 'edit';
  if (/^(read|glob|grep|ls|notebookread)$/i.test(toolName)) return 'read';
  if (/^(webfetch|websearch)$/i.test(toolName)) return 'fetch';
  return undefined;
}

export class ClaudeAdapter implements CLIAdapter {
  readonly name = 'claude';
  readonly displayName = 'Claude Code';
  readonly command = 'claude';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: true, hasModel: true, hasSearch: false, hasBudget: true,
    approvals: true,
  };

  constructor(
    private readonly spawnClaude: ClaudeSpawn = spawnCli,
    private readonly interruptGraceMs = INTERRUPT_GRACE_MS,
  ) {}

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const { settings } = opts;
    const workDir = settings.workDir || opts.workDir;
    if (opts.signal?.aborted) return Promise.resolve({ text: '已取消', error: true });

    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio',
      ...(PERMISSION_ARGS[settings.mode] ?? PERMISSION_ARGS.safe),
    ];
    if (settings.maxTurns > 0) args.push('--max-turns', String(settings.maxTurns));
    if (EFFORTS.includes(settings.effort)) args.push('--effort', settings.effort);
    else if (settings.effort) log.warn(`[claude] 忽略无效 effort: ${settings.effort}`);
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

    // Images go to Claude natively as base64 blocks; other files are listed as paths.
    const { images, others } = splitMedia(opts.media);
    const text = buildMediaPrompt(prompt, others, workDir);

    log.debug(`[claude] workDir=${workDir} effort=${settings.effort} model=${settings.model || 'default'} mode=${settings.mode} resume=${sid || 'none'} images=${images.length} timeout=${opts.timeout ?? 'none'}`);

    return this.run(args, workDir, userMessage(text, images), opts, sid);
  }

  private run(args: string[], workDir: string | undefined, message: object, opts: ExecOptions, sid: string | undefined): Promise<ExecResult> {
    return new Promise((resolve) => {
      const { settings } = opts;
      const start = Date.now();
      const msgMode = settings.msgMode || 'compact';
      const { onIntermediate } = opts;
      const streamIntermediate = msgMode !== 'compact' && onIntermediate;

      const proc = this.spawnClaude(this.command, args, {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let resultText = '';
      let thinking = '';
      let sessionId: string | undefined;
      let cost: number | undefined;
      let usage: ExecResult['usage'];
      let error = false;
      let resultSeen = false;
      // The turn's own result came in before any idle stop (not one our interrupt provoked).
      let resultBeforeStop = false;
      let stopReason: 'cancel' | 'timeout' | null = null;
      let stderr = '';
      let settled = false;
      // tool_use id → tool name, so parallel tool results are labelled with their own tool.
      const toolNames = new Map<string, string>();
      // can_use_tool requests the CLI has since cancelled: their late answers are dropped.
      const cancelledRequests = new Set<string>();
      // Pending approvals, aborted when the CLI cancels the ask or the run ends/is cancelled.
      const pendingAsks = new Map<string, AbortController>();
      const abortAsks = (): void => { for (const c of pendingAsks.values()) c.abort(); pendingAsks.clear(); };
      let requestSeq = 0;

      const send = (obj: object): void => {
        const stdin = proc.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded) return;
        stdin.write(JSON.stringify(obj) + '\n', 'utf8');
      };
      const endInput = (): void => { if (proc.stdin && !proc.stdin.writableEnded) proc.stdin.end(); };
      proc.stdin?.on('error', (e) => log.debug('[claude] stdin write error (ignored):', (e as Error).message));

      // Idle timeout: re-armed on every stdout line (including tool_progress / task_progress
      // heartbeats, which are otherwise not shown) and paused while waiting for the user, so a
      // long-but-healthy run is never cut off while one that went silent (e.g. a tool blocked
      // on a sudo password prompt) is stopped after `timeout` of silence.
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      // Asks currently waiting on the user. While any is open the idle clock stays off: the CLI
      // keeps writing keep_alive lines meanwhile, and those must not re-arm it.
      let waitingOnUser = 0;
      const pauseIdle = (): void => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };
      const armIdle = (): void => {
        if (!opts.timeout || settled || stopReason || waitingOnUser > 0) return;
        pauseIdle();
        idleTimer = setTimeout(() => stop('timeout'), opts.timeout);
      };
      // Stop politely first (interrupt ends the turn and still yields a result), then kill.
      const stop = (reason: 'cancel' | 'timeout'): void => {
        if (stopReason || settled) return;
        stopReason = reason;
        pauseIdle();
        if (reason === 'timeout') log.warn(`[claude] 空闲超时 (${opts.timeout}ms 无消息)，发送 interrupt`);
        send({ type: 'control_request', request_id: `wx_interrupt_${++requestSeq}`, request: { subtype: 'interrupt' } });
        // interrupt -> SIGTERM (taskkill /F on Windows) -> SIGKILL, one grace period apart.
        killTimer = setTimeout(() => {
          killProc(proc);
          killTimer = setTimeout(() => {
            if (proc.exitCode !== null || proc.signalCode !== null) return;
            log.warn('[claude] SIGTERM 后进程仍未退出，发送 SIGKILL');
            try { proc.kill('SIGKILL'); } catch { /* already gone */ }
          }, this.interruptGraceMs);
        }, this.interruptGraceMs);
      };
      const onAbort = (): void => { abortAsks(); stop('cancel'); };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      const answerPermission = async (requestId: string, req: CanUseToolRequest): Promise<void> => {
        const waitsOnUser = req.tool_name === 'AskUserQuestion' || (settings.mode === 'safe' && !!opts.requestPermission);
        if (waitsOnUser) { waitingOnUser++; pauseIdle(); } // waiting on the user is not the agent going idle
        const ask = new AbortController();
        pendingAsks.set(requestId, ask);
        let decision: PermissionDecision;
        try {
          decision = await decidePermission(req, {
            mode: settings.mode, askUser: opts.askUser, requestPermission: opts.requestPermission, signal: ask.signal,
          });
        } catch (err) {
          decision = { behavior: 'deny', message: `权限处理出错：${(err as Error).message}` };
        }
        pendingAsks.delete(requestId);
        if (waitsOnUser) { waitingOnUser--; armIdle(); }
        if (cancelledRequests.delete(requestId)) return;
        send({
          type: 'control_response',
          response: { subtype: 'success', request_id: requestId, response: { ...decision, toolUseID: req.tool_use_id } },
        });
      };

      const handle = (msg: any): void => {
        switch (msg.type) {
          case 'control_request': {
            const req = msg.request ?? {};
            if (req.subtype === 'can_use_tool') { void answerPermission(msg.request_id, req as CanUseToolRequest); return; }
            // Hooks, SDK MCP servers etc. are never registered by us; answer so nothing waits.
            send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `unsupported control request: ${req.subtype}` } });
            return;
          }
          case 'control_cancel_request':
            cancelledRequests.add(msg.request_id);
            pendingAsks.get(msg.request_id)?.abort();
            return;
          case 'system':
            // Known before any work happens, so a cancelled/timed-out run can still be resumed.
            if (msg.subtype === 'init') {
              sessionId = msg.session_id;
              log.debug(`[claude] init model=${msg.model} permissionMode=${msg.permissionMode} version=${msg.claude_code_version}`);
            }
            return;
          case 'assistant': {
            // Messages from inside a subagent (parent_tool_use_id set) are not forwarded: the
            // main thread's Agent/Task tool_use line and its tool_result stand for it.
            if (msg.parent_tool_use_id) return;
            for (const block of msg.message?.content ?? []) {
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
            return;
          }
          case 'user': {
            const content = msg.message?.content;
            if (msg.parent_tool_use_id || !Array.isArray(content)) return;
            for (const block of content) {
              if (block.type !== 'tool_result') continue;
              const toolName = toolNames.get(block.tool_use_id);
              toolNames.delete(block.tool_use_id);
              if (!streamIntermediate || !block.content) continue;
              const summary = summarizeToolResult(toolName, block.content);
              if (summary) onIntermediate({ type: 'tool_result', content: summary, toolName });
            }
            return;
          }
          case 'result':
            resultSeen = true;
            if (!stopReason) resultBeforeStop = true;
            sessionId = msg.session_id || sessionId;
            if (typeof msg.total_cost_usd === 'number') cost = msg.total_cost_usd;
            if (msg.usage) {
              usage = {
                inputTokens: msg.usage.input_tokens ?? 0,
                outputTokens: msg.usage.output_tokens ?? 0,
                cacheReadTokens: msg.usage.cache_read_input_tokens,
                cacheWriteTokens: msg.usage.cache_creation_input_tokens,
              };
            }
            if (msg.subtype === 'success') {
              resultText = msg.result || '(无输出)';
              error = !!msg.is_error;
            } else {
              resultText = describeResultError(msg, settings);
              error = true;
            }
            // One turn per execute(): closing stdin lets the CLI exit once the turn is done.
            endInput();
            return;
          // tool_progress, task_*, status, rate-limit, keep_alive, control_response …: heartbeat only.
        }
      };

      let buf = '';
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          armIdle();
          let msg: unknown;
          try { msg = JSON.parse(line); } catch { log.debug(`[claude] non-JSON stdout: ${line.slice(0, 200)}`); continue; }
          try { handle(msg); } catch (err) { log.warn('[claude] 处理消息出错:', err); }
        }
      });
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });

      const finish = (res: ExecResult): void => {
        if (settled) return;
        settled = true;
        pauseIdle();
        abortAsks();
        if (killTimer) clearTimeout(killTimer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(res);
      };

      proc.on('close', (code) => {
        const duration = Date.now() - start;
        if (stopReason === 'cancel') { finish({ text: '已取消', sessionId, cost, duration, error: true }); return; }
        // A result that is the real answer wins over the timeout notice: one that arrived before the
        // idle stop fired (the CLI was just slow to exit), or a successful one that raced it. An
        // error result provoked by our interrupt is reported as the timeout it is.
        if (stopReason === 'timeout' && !(resultSeen && (resultBeforeStop || !error))) {
          const mins = Math.round((opts.timeout ?? 0) / 60000);
          finish({
            text: `执行超时（${mins} 分钟无响应），已自动中止。\n可能是某个命令在等待输入（如 sudo 密码）。`,
            sessionId, cost, duration, error: true,
          });
          return;
        }
        if (resultSeen) {
          finish({
            text: resultText,
            thinking: thinking || undefined,
            sessionId, cost, usage, duration, error,
            sessionExpired: error && !!sid && isStaleSession(resultText),
          });
          return;
        }
        // Exited without a result: crash, bad flag, auth failure, stale --resume id, …
        const detail = stderr.trim() || `exit ${code}`;
        log.warn(`[claude] 进程退出但没有 result (code=${code}): ${detail.slice(0, 300)}`);
        finish({
          text: `Claude Code 异常退出（code ${code}）：${detail}`,
          sessionId, cost, duration, error: true,
          sessionExpired: !!sid && isStaleSession(detail),
        });
      });
      proc.on('error', (err) => finish({ text: `无法启动: ${err.message}`, error: true }));

      // The SDK opens with initialize before the first user turn; mirror it (all session
      // options travel as flags, so the request itself carries nothing).
      send({ type: 'control_request', request_id: `wx_init_${++requestSeq}`, request: { subtype: 'initialize' } });
      send(message);
      armIdle();
    });
  }
}

function isStaleSession(text: string): boolean {
  // Claude reports a stale --resume id as "No conversation found with session ID: …".
  return isSessionError(text) || /no conversation found/i.test(text);
}

function denyMessage(mode: ToolMode, toolName: string): string {
  if (mode === 'plan') {
    if (toolName === 'ExitPlanMode') return 'plan 模式只出计划、不执行。请把完整计划直接作为最终回复输出给用户；用户确认后会用 /mode auto 执行。';
    return `plan 模式为只读规划，不允许执行 ${toolName}；如需执行可用 /mode auto`;
  }
  return `safe 模式下 ${toolName} 需要审批，微信内审批将在后续版本支持；可用 /mode auto`;
}

function describeResultError(msg: { subtype?: string; errors?: string[] }, settings: UserSettings): string {
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

/** The one user turn written to stdin (same envelope the SDK writes for a prompt). */
function userMessage(text: string, images: InlineImage[]): object {
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        ...(text.trim() || images.length === 0 ? [{ type: 'text', text }] : []),
      ],
    },
  };
}
