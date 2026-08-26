import { log } from '../utils/logger.js';
import { DEFAULT_CLI_TIMEOUT } from '../config.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, IntermediateMessage } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, stripAnsi, summarizeToolUse, summarizeToolResult } from './base.js';
import type { DownloadedMedia } from '../utils/media.js';
import { copyMediaToWorkDir } from '../utils/media.js';
import { execSync } from 'node:child_process';
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import type { Part, ToolPart, ToolState } from '@opencode-ai/sdk';

const modelResolveCache = new Map<string, string>();

export function resolveBareModelFromList(model: string, availableModels: string[]): string {
  const raw = model.trim().replace(/\/+$/, '');
  if (!raw || raw.includes('/')) return raw;

  const suffix = `/${raw.toLowerCase()}`;
  const matches = availableModels
    .map((item) => item.trim())
    .filter((item) => item.includes('/'))
    .filter((item) => item.toLowerCase().endsWith(suffix));

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return raw;

  const preferred = matches.find((item) => /baiduqianfancodingplan/i.test(item));
  return preferred || raw;
}

function buildMediaPrompt(prompt: string, media?: DownloadedMedia[], workDir?: string): string {
  if (!media || media.length === 0) return prompt;
  
  const copiedMedia = workDir ? media.map(m => copyMediaToWorkDir(m, workDir)) : media;
  
  const fileList = copiedMedia.map(m => {
    const relativePath = workDir && m.path.startsWith(workDir) 
      ? m.path.slice(workDir.length).replace(/^[\/\\]/, '')
      : m.path;
    const typeNames: Record<string, string> = { image: '图片', file: '文件', video: '视频' };
    const sizeStr = m.size ? `${(m.size / 1024).toFixed(1)}KB` : '未知大小';
    return `- ${m.fileName}\n  类型: ${typeNames[m.type] || '文件'}\n  大小: ${sizeStr}\n  路径: ${relativePath}`;
  }).join('\n\n');
  
  const userPrompt = prompt.trim() && !prompt.startsWith('[文件:') && !prompt.startsWith('[图片:') && !prompt.startsWith('[视频:')
    ? `\n\n用户说：${prompt}`
    : '';
  
  return `已接收到用户通过微信发送的文件：

${fileList}

文件已保存到工作目录。请勿主动读取或处理这些文件，等待用户明确指示需要做什么。${userPrompt}`;
}

/** Parse a tool state into IntermediateMessage events */
function emitToolStateEvents(
  toolName: string,
  state: ToolState,
  onIntermediate?: (msg: IntermediateMessage) => void,
): void {
  if (!onIntermediate) return;

  switch (state.status) {
    case 'running':
      // `pending` is skipped on purpose: it carries no input yet, so emitting it would
      // produce a second, argument-less `- Tool` line for the same call (OpenCode sends
      // pending then running for every tool). Emitting only `running` yields exactly one
      // line per tool, matching the Claude adapter's behavior.
      onIntermediate({
        type: 'tool_use',
        content: summarizeToolUse(toolName, state.input),
        toolName,
      });
      break;
    case 'completed':
      if (state.output) {
        const summary = summarizeToolResult(toolName, state.output);
        if (summary) {
          onIntermediate({
            type: 'tool_result',
            content: summary,
            toolName,
          });
        }
      }
      break;
    case 'error':
      onIntermediate({
        type: 'tool_result',
        content: `  ↳ Error: ${(state.error || '').substring(0, 100)}`,
        toolName,
      });
      break;
  }
}

/** Extract result text and thinking from session parts */
function extractResultFromParts(parts: Part[]): { text: string; thinking: string } {
  let text = '';
  let thinking = '';
  for (const part of parts) {
    if (part.type === 'text') {
      text += (part as any).text || '';
    } else if (part.type === 'reasoning') {
      thinking += (part as any).text || '';
    }
  }
  return { text, thinking };
}

/** Shared SDK client — lazily started, reused across calls */
type OpencodeSdkClient = import('@opencode-ai/sdk').OpencodeClient;
let sharedClient: OpencodeSdkClient | null = null;
let sharedServerClose: (() => void) | null = null;
// Concurrent cold starts must share one connect/spawn attempt. The bridge runs
// tools concurrently, and two unguarded `createOpencode()` calls race for the same
// port: one loses, and the winner's `sharedServerClose` is overwritten, orphaning a
// server that holds :4096 — the exact failure this adapter exists to avoid.
let clientInflight: Promise<OpencodeSdkClient> | null = null;

/** Stop the opencode server this adapter spawned (no-op when connecting to an existing one). */
export function closeOpenCodeServer(): void {
  sharedServerClose?.();
  sharedServerClose = null;
  sharedClient = null;
  clientInflight = null;
}

async function connectOrStartClient(): Promise<OpencodeSdkClient> {
  // Prefer connecting to an existing opencode server (e.g. `opencode serve` or a TUI
  // instance). Spawning our own server on a fixed port is fragile across restarts:
  // orphaned `opencode serve` processes hold the port and force `createOpencode()` to
  // fail, then leave the client in a broken state. A standalone server is also what the
  // real deployment looks like — one headless server, many bridge instances.
  try {
    const existing = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' });
    await existing.session.list();
    log.info('[opencode/sdk] connected to existing server on :4096');
    return existing;
  } catch (err) {
    log.warn(`[opencode/sdk] no server on :4096 (${(err as Error).message}), starting own server`);
  }

  try {
    const { client, server } = await createOpencode();
    sharedServerClose = () => server.close();
    log.info('[opencode/sdk] server started');
    return client;
  } catch (err) {
    throw new Error(`无法启动 OpenCode SDK: ${(err as Error).message}`);
  }
}

async function getOrCreateClient(): Promise<OpencodeSdkClient> {
  if (sharedClient) return sharedClient;
  // Only a successful probe is cached. Assigning the probe client up front left a dead
  // client behind whenever the :4096 probe failed and `createOpencode()` then threw:
  // every later call took the `if (sharedClient)` fast path and returned it verbatim.
  if (!clientInflight) {
    clientInflight = connectOrStartClient()
      .then((client) => { sharedClient = client; return client; })
      .finally(() => { clientInflight = null; });
  }
  return clientInflight;
}

/**
 * Every session-scoped endpoint takes the working directory as a `directory` query
 * param. Without it the session runs in the server's own cwd, so `/cd` is ignored and
 * the media files copied into workDir are unreachable by the relative paths we hand
 * the model in the prompt.
 */
function dirQuery(workDir?: string): { directory: string } | undefined {
  return workDir ? { directory: workDir } : undefined;
}

/** Resolves the SDK client. Injectable so the adapter can be driven by a fake in tests. */
export type OpenCodeClientFactory = () => Promise<OpencodeSdkClient>;

export class OpenCodeAdapter implements CLIAdapter {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';
  readonly command = 'opencode';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: true, hasSearch: false, hasBudget: false,
  };

  // '' means "asked this server, it has no plan agent"; undefined means "not asked yet".
  private planAgent: string | undefined;

  constructor(private readonly clientFactory: OpenCodeClientFactory = getOrCreateClient) {}

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  close(): void {
    closeOpenCodeServer();
  }

  /**
   * Plan mode maps onto opencode's own `plan` agent. Agents are server/config defined,
   * so the name is only sent when this server actually publishes it — an unknown agent
   * is a 400 that would fail the whole turn.
   */
  private async resolvePlanAgent(
    client: OpencodeSdkClient,
    directory?: { directory: string },
  ): Promise<string | undefined> {
    if (this.planAgent !== undefined) return this.planAgent || undefined;
    try {
      const result = await client.app.agents(directory ? { query: directory } : {});
      // @ts-ignore
      const agents = (result?.data || result) as Array<{ name?: string; mode?: string }>;
      const found = Array.isArray(agents)
        && agents.some((agent) => agent?.name === 'plan' && agent.mode !== 'subagent');
      this.planAgent = found ? 'plan' : '';
    } catch (err) {
      log.debug(`[opencode/sdk] agent list unavailable: ${(err as Error).message}`);
      this.planAgent = '';
    }
    if (!this.planAgent) log.warn('[opencode] 该 opencode server 未提供 plan agent，/mode plan 不生效');
    return this.planAgent || undefined;
  }

private resolveModelArg(model: string, workDir?: string): string {
    const raw = model.trim().replace(/\/+$/, '');
    if (!raw || raw.includes('/')) return raw;

    const key = raw.toLowerCase();
    const cached = modelResolveCache.get(key);
    if (cached) return cached;

    try {
      const output = execSync('opencode models', {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const availableModels = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const resolved = resolveBareModelFromList(raw, availableModels);
      if (resolved !== raw) {
        modelResolveCache.set(key, resolved);
        log.debug(`[opencode] model alias resolved: ${raw} -> ${resolved}`);
        return resolved;
      }
      log.warn(`[opencode] model not found in available models: ${raw}, tried: ${availableModels.slice(0, 10).join(', ')}`);
      return raw;
    } catch (err) {
      log.warn(`[opencode] models command failed: ${(err as Error).message}`);
      return raw;
    }
  }

  async execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const { settings, onIntermediate, signal } = opts;
    const workDir = settings.workDir || opts.workDir;
    const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);

    // Determine model
    let providerID = '';
    let modelID = '';
    if (settings.model) {
      const resolvedModel = this.resolveModelArg(settings.model, workDir);
      const parts = resolvedModel.split('/');
      if (parts.length === 2) {
        providerID = parts[0];
        modelID = parts[1];
      }
    }

    const client = await this.clientFactory();
    const directory = dirQuery(workDir);
    const dirOpt = directory ? { query: directory } : {};

    // Reuse the session this user was already talking to. `capabilities.sessionResume`
    // is advertised to the Router, which persists the returned id and tells the user the
    // conversation is continuing — creating a fresh session per message (and deleting it
    // on the way out) made every WeChat turn context-free while still claiming otherwise.
    let sessionId = '';
    const prevSid = settings.sessionIds[this.name];
    if (prevSid) {
      try {
        await client.session.get({ path: { id: prevSid }, ...dirOpt });
        sessionId = prevSid;
        log.debug(`[opencode/sdk] resumed session: ${sessionId}`);
      } catch {
        log.debug(`[opencode/sdk] stored session ${prevSid} is gone, starting a new one`);
      }
    }

    if (!sessionId) {
      const session = await client.session.create({
        body: { title: 'cli-in-wechat' },
        ...dirOpt,
      });
      // @ts-ignore
      sessionId = session.data?.id || session.id || '';
      if (!sessionId) {
        throw new Error('Failed to create OpenCode session');
      }
      log.debug(`[opencode/sdk] session created: ${sessionId}`);
    }

    // Subscribe to SSE events
    const seenToolCallIds = new Set<string>();
    const textParts = new Map<string, string>();
    // messageID → role (user/assistant), populated from `message.updated` so we can
    // skip the echo of the user's own message that OpenCode re-broadcasts as a text part.
    const roleByMessageID = new Map<string, string>();
    let resultText = '';
    let resultThinking = '';
    let resultError = false;
    let finished = false;

    const msgMode = settings.msgMode || 'normal';
    const streamIntermediate = msgMode !== 'compact' && onIntermediate;

    // Every execute() opened a fresh SSE subscription and never closed it: the loop only
    // returns when a *later* event arrives after `finished`, so a quiet stream stayed open
    // for the life of the process, one leaked subscription per WeChat message.
    const sseAbort = new AbortController();
    const sseResult = await client.event.subscribe({ signal: sseAbort.signal });
    const sseDone = (async () => {
      try {
        for await (const ev of sseResult.stream) {
          if (finished) return;
          const type = (ev as any)?.type as string | undefined;
          const properties = (ev as any)?.properties as Record<string, unknown> | undefined;
          if (!properties) continue;

          // Only process events for our session
          const evSessionId = (properties as any).sessionID
            || (properties as any).info?.sessionID
            || (properties as any).part?.sessionID;
          if (evSessionId && evSessionId !== sessionId) continue;

          switch (type) {
            case 'message.updated': {
              const info = (properties as any).info as Record<string, unknown> | undefined;
              if (info?.id && info?.role) {
                roleByMessageID.set(info.id as string, info.role as string);
              }
              break;
            }

            case 'message.part.updated': {
              const part = (properties as any).part as Part | undefined;
              if (!part) continue;

              // Skip the echo of the user's own message: OpenCode re-broadcasts the user
              // prompt as a text part (role=user). We only want assistant output. This also
              // prevents the SEND_FILE marker (which the system prompt asks the model to
              // emit for file delivery) from being echoed back to the user.
              const partRole = roleByMessageID.get((part as any).messageID as string);
              if (partRole && partRole !== 'assistant') continue;

              // `message.part.updated` carries full-part snapshots and is the "block"-level
              // event: for a text part it arrives once with the complete text (verified: a
              // whole poem arrives as a single 51-char part). `message.part.delta` is the
              // per-token slice of the same part (74 deltas for the same poem) — WeChat can
              // only render bubbles, so we emit text blocks from `updated` only and ignore
              // text deltas. The 2.5s debounce in the Router merges nearby blocks.
              if (part.type === 'text') {
                const textPart = part as any;
                const partId = (part as any).id as string | undefined;
                const text = textPart.text || '';
                // Full snapshot replaces this part's text (keyed by part id) so a
                // multi-part turn keeps every segment without duplication.
                // `updated` carries the whole part every time, so a part that grows over
                // several snapshots would be pushed to WeChat once per snapshot, each copy
                // longer than the last. Emit only the suffix that is actually new; the
                // stored snapshot still replaces wholesale for the final assembly.
                const previous = partId ? (textParts.get(partId) || '') : '';
                if (partId) {
                  if (text) textParts.set(partId, text);
                } else {
                  resultText = text;
                }
                const fresh = text.startsWith(previous) ? text.slice(previous.length) : text;
                if (streamIntermediate && fresh.trim()) {
                  onIntermediate!({ type: 'text', content: fresh });
                }
              } else if (part.type === 'reasoning') {
                const reasoningPart = part as any;
                resultThinking += reasoningPart.text || '';
                if (streamIntermediate && reasoningPart.text?.trim()) {
                  onIntermediate!({ type: 'thinking', content: reasoningPart.text });
                }
              } else if (part.type === 'tool') {
                const toolPart = part as ToolPart;
                const toolName = toolPart.tool || 'Tool';
                const callId = toolPart.callID || '';

                // Only emit events once per callID state transition
                const key = `${callId}:${toolPart.state.status}`;
                if (seenToolCallIds.has(key)) continue;
                seenToolCallIds.add(key);

                emitToolStateEvents(toolName, toolPart.state, streamIntermediate ? onIntermediate : undefined);
              }
              break;
            }

            // Incremental per-token deltas. WeChat renders bubbles, not tokens, so text
            // deltas are skipped — the full text already arrives via `message.part.updated`
            // above. Reasoning deltas are only kept if thinking is enabled (updated already
            // carries the full reasoning snapshot, so these are redundant too).
            case 'message.part.delta': {
              break;
            }

            // A headless bridge has nobody to answer a permission prompt. Left unanswered
            // the session simply stops until the (now one hour) timeout fires, so every
            // request is resolved here: approved under /mode auto, refused otherwise so
            // the model gets a real denial and can carry on.
            case 'permission.updated': {
              const permission = properties as unknown as { id?: string; sessionID?: string; title?: string };
              if (!permission.id) break;
              const response = settings.mode === 'auto' ? 'always' : 'reject';
              void client.postSessionIdPermissionsPermissionId({
                path: { id: sessionId, permissionID: permission.id },
                body: { response },
                ...dirOpt,
              }).catch((err: unknown) => {
                log.warn(`[opencode/sdk] permission reply failed: ${(err as Error).message}`);
              });
              if (response === 'reject' && streamIntermediate) {
                onIntermediate!({
                  type: 'tool_result',
                  content: `  ↳ 已拒绝权限请求（${permission.title || '未知操作'}）：非 auto 模式`,
                });
              }
              break;
            }

          case 'session.idle':
            finished = true;
            break;

            case 'session.error': {
              const error = (properties as any).error;
              if (error) {
                resultError = true;
                if (error.message) {
                  resultText += `\n[Error: ${error.message}]`;
                }
              }
              finished = true;
              break;
            }

            case 'session.status': {
              const status = (properties as any).status;
              if (status?.type === 'idle') {
                finished = true;
              }
              break;
            }
          }
        }
      } catch (err) {
        log.error(`[opencode/sdk] SSE error: ${(err as Error).message}`);
      }
    })();

    // Small delay to ensure SSE listener is active before sending prompt
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Build model config
    const modelConfig: Record<string, unknown> = {};
    if (providerID && modelID) {
      modelConfig.model = { providerID, modelID };
    }

    // `permissionMode` was invented: no such field exists on the prompt body anywhere in
    // @opencode-ai/sdk, and the `as any` cast hid that from tsc, so /mode auto and /mode
    // plan were silently dropped. Permissions are answered through `permission.updated`
    // in the SSE loop above; plan mode is the server's own `plan` agent, used only when
    // this server actually publishes one.
    const agentName = settings.mode === 'plan'
      ? await this.resolvePlanAgent(client, directory)
      : undefined;

    // Send prompt async (non-blocking)
    try {
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: fullPrompt }],
          ...modelConfig,
          ...(agentName ? { agent: agentName } : {}),
        } as any,
        ...dirOpt,
      });
      log.debug(`[opencode/sdk] prompt sent async${agentName ? ` (agent=${agentName})` : ''}`);
    } catch (err) {
      log.error(`[opencode/sdk] promptAsync failed: ${(err as Error).message}`);
      resultError = true;
      resultText = `发送提示失败: ${(err as Error).message}`;
      finished = true;
    }

    // Wait for completion (poll session status or use timeout)
    const start = Date.now();
    const timeout = opts.timeout || DEFAULT_CLI_TIMEOUT;

    while (!finished && (Date.now() - start) < timeout) {
      if (signal?.aborted) {
        try {
          await client.session.abort({ path: { id: sessionId }, ...dirOpt });
        } catch { /* ignore */ }
        sseAbort.abort();
        return { text: '已取消', sessionId, error: true };
      }

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check session status
      try {
        const statusResult = await client.session.status({ ...dirOpt });
        // @ts-ignore
        const statuses = statusResult.data || statusResult;
        const sessionStatus = (statuses as any)?.[sessionId];
        if (sessionStatus?.type === 'idle') {
          finished = true;
        }
      } catch {
        // ignore status errors
      }
    }

    if (Date.now() - start >= timeout && !finished) {
      try {
        await client.session.abort({ path: { id: sessionId }, ...dirOpt });
      } catch { /* ignore */ }
      resultText += '\n[超时]';
      resultError = true;
    }

    // Assemble full text from per-part snapshots collected via `message.part.updated`.
    const assembledText = Array.from(textParts.values()).join('\n\n');
    if (assembledText && !resultText) resultText = assembledText;

    // Fetch final result from session messages
    try {
      const messagesResult = await client.session.messages({
        path: { id: sessionId },
        query: { ...(directory || {}), limit: 1 },
      });
      // @ts-ignore
      const messages = messagesResult.data || messagesResult;
      if (Array.isArray(messages) && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const parts = lastMsg?.parts || [];
        const extracted = extractResultFromParts(parts);
        if (extracted.text && !resultText) resultText = extracted.text;
        if (extracted.thinking && !resultThinking) resultThinking = extracted.thinking;
      }
    } catch (err) {
      log.debug(`[opencode/sdk] failed to fetch messages: ${(err as Error).message}`);
    }

    // The session is deliberately kept: it is this user's conversation, and the Router
    // persists the id for the next turn. Only the SSE subscription is released here.
    sseAbort.abort();
    await sseDone.catch(() => { /* the abort itself surfaces here */ });

    return {
      text: resultText || '(无输出)',
      thinking: resultThinking || undefined,
      sessionId,
      duration: Date.now() - start,
      error: resultError,
    };
  }
}
