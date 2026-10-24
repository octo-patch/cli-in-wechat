import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';
import { commandExists, spawnCli, ShellFallbackRefusedError, killProc, setupAbort, writeStdin, stripAnsi, buildMediaPrompt, collectUtf8 } from './base.js';

/**
 * Minimal adapter for any plain-text CLI declared in config.json (`protocol: "text"`):
 * spawn `command args…`, hand it the prompt, return its ANSI-stripped stdout. No streaming,
 * no session resume, /mode is always auto. Exit code ≠ 0 is an error.
 *
 * The prompt goes on stdin (default) or, with `promptVia: "arg"`, replaces every "{prompt}"
 * placeholder in args (appended as the last arg when there is none). The argv form uses
 * spawnCli in strict mode: on Windows it refuses (rather than run the WeChat text through
 * cmd.exe) when the command can't be resolved to a direct .exe/.js target.
 */
export interface TextAgentSpec {
  name: string;
  displayName: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  promptVia: 'stdin' | 'arg';
}

export type TextSpawn = typeof spawnCli;

const PLACEHOLDER = '{prompt}';

export class TextAdapter implements CLIAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly command: string;
  readonly capabilities: AdapterCapabilities = {
    streaming: false, jsonOutput: false, sessionResume: false,
    modes: ['auto'], hasEffort: false, hasModel: false, hasSearch: false, hasBudget: false,
  };

  constructor(readonly spec: TextAgentSpec, private readonly spawnAgent: TextSpawn = spawnCli) {
    this.name = spec.name;
    this.displayName = spec.displayName;
    this.command = spec.command;
  }

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

  execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    if (opts.signal?.aborted) return Promise.resolve({ text: '已取消', error: true });
    const workDir = opts.settings.workDir || opts.workDir;
    const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
    const viaArg = this.spec.promptVia === 'arg';
    let args = this.spec.args;
    if (viaArg) {
      args = args.some((a) => a.includes(PLACEHOLDER))
        ? args.map((a) => a.split(PLACEHOLDER).join(fullPrompt))
        : [...args, fullPrompt];
    }
    args = [...args, ...(opts.extraArgs ?? [])];

    return new Promise((resolve) => {
      let settled = false;
      const done = (r: ExecResult) => { if (!settled) { settled = true; resolve(r); } };
      const start = Date.now();

      let proc;
      try {
        proc = this.spawnAgent(this.command, args, {
          cwd: workDir, stdio: [viaArg ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.spec.env },
        }, { strict: viaArg });
      } catch (e) {
        if (e instanceof ShellFallbackRefusedError) {
          done({
            text: `${this.displayName}: Windows 下无法安全地把消息作为参数传给 ${this.command}（找不到可直接启动的 .exe/.js，`
              + '走 cmd.exe 会有命令注入风险），已拒绝执行。请在 config.json 里改用 "promptVia": "stdin"。',
            error: true,
          });
          return;
        }
        done({ text: `无法启动 ${this.displayName}: ${(e as Error).message}`, error: true });
        return;
      }

      setupAbort(proc, opts.signal);
      let timedOut = false;
      const timer = opts.timeout ? setTimeout(() => { timedOut = true; killProc(proc); }, opts.timeout) : null;
      const out = collectUtf8(proc);
      if (!viaArg) writeStdin(proc, fullPrompt);
      log.debug(`[${this.name}] prompt via ${this.spec.promptVia}: ${fullPrompt.substring(0, 200)}`);

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { done({ text: '已取消', error: true }); return; }
        const stdout = stripAnsi(out.stdout()).trim();
        if (timedOut) {
          const partial = stdout ? `${stdout}\n\n` : '';
          done({ text: `${partial}[${this.displayName} ${Math.round(opts.timeout! / 1000)}s 未完成，已超时终止]`, error: true });
          return;
        }
        const stderr = stripAnsi(out.stderr()).trim();
        done({
          text: (code === 0 ? stdout || stderr : stderr || stdout) || `exit ${code}`,
          duration: Date.now() - start,
          error: code !== 0 || undefined,
        });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        done({ text: `无法启动 ${this.displayName}: ${err.message}`, error: true });
      });
    });
  }
}
