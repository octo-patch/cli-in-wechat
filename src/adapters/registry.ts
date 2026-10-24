import { log } from '../utils/logger.js';
import type { CLIAdapter } from './base.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import { KimiAdapter } from './kimi.js';
import { OpenCodeAdapter } from './opencode-sdk.js';
import { OpenCodeAdapter as OpenCodeCliAdapter } from './opencode.js';
import { AcpAdapter, type AcpPreset } from './acp/adapter.js';
import { ACP_PRESETS } from './acp/presets.js';
import { TextAdapter } from './text.js';
import type { AgentConfig } from '../config.js';

const NATIVE_NAMES = new Set(['claude', 'codex', 'gemini', 'kimi', 'opencode', 'opencode-cli']);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isStrRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

/**
 * Merge config.json `agents` over the built-in ACP presets and build one adapter per entry.
 * Same name → the given fields replace the preset's (protocol defaults to 'acp'); `disabled`
 * drops it; a new name is added. Bad entries are warned about and skipped, never fatal.
 */
export function resolveAgentAdapters(agents: unknown, presets: AcpPreset[] = ACP_PRESETS): CLIAdapter[] {
  const merged = new Map<string, AgentConfig>(presets.map((p) => [p.name, { ...p, protocol: 'acp' as const }]));
  for (const raw of Array.isArray(agents) ? agents : []) {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Partial<AgentConfig>;
    const label = typeof a.name === 'string' ? a.name : JSON.stringify(raw);
    const bad = (why: string) => log.warn(`[config] agents 条目 ${label} 无效（${why}），已跳过`);
    if (typeof a.name !== 'string' || !/^[a-z0-9-]+$/.test(a.name)) { bad('name 须为 [a-z0-9-]+'); continue; }
    if (NATIVE_NAMES.has(a.name)) { bad('与内置工具重名'); continue; }
    const base = merged.get(a.name);
    if (a.disabled === true) { merged.delete(a.name); continue; }
    const next: AgentConfig = { ...base, ...a } as AgentConfig;
    next.protocol ??= 'acp';
    if (next.protocol !== 'acp' && next.protocol !== 'text') { bad('protocol 须为 acp 或 text'); continue; }
    if (typeof next.command !== 'string' || !next.command.trim()) { bad('command 不能为空'); continue; }
    if (next.args !== undefined && !isStrArray(next.args)) { bad('args 须为字符串数组'); continue; }
    if (next.env !== undefined && !isStrRecord(next.env)) { bad('env 须为字符串字典'); continue; }
    if (next.modeIds !== undefined && !isStrRecord(next.modeIds)) { bad('modeIds 须为字符串字典'); continue; }
    if (next.promptVia !== undefined && next.promptVia !== 'stdin' && next.promptVia !== 'arg') { bad('promptVia 须为 stdin 或 arg'); continue; }
    merged.set(a.name, next);
  }
  return Array.from(merged.values(), (a) => {
    const common = { name: a.name, displayName: a.displayName || a.name, command: a.command!, args: a.args ?? [], env: a.env };
    return a.protocol === 'text'
      ? new TextAdapter({ ...common, promptVia: a.promptVia ?? 'stdin' })
      : new AcpAdapter({ ...common, modeIds: a.modeIds });
  });
}

export class AdapterRegistry {
  private adapters = new Map<string, CLIAdapter>();
  private available = new Set<string>();
  private byDisplayName = new Map<string, string>(); // displayName → name
  // Fallback chains: primary name → [fallback names]
  private fallbackChains = new Map<string, string[]>();

  constructor(agents?: AgentConfig[]) {
    this.register(new ClaudeAdapter());
    this.register(new CodexAdapter());
    this.register(new GeminiAdapter());
    this.register(new KimiAdapter());
    // Register SDK adapter as primary, CLI adapter as fallback
    this.register(new OpenCodeAdapter());
    this.register(new OpenCodeCliAdapter(), 'opencode-cli');
    this.fallbackChains.set('opencode', ['opencode-cli']);
    // Generic ACP agents (Qwen Code, Copilot, Cursor, CodeBuddy, Droid, Devin, Qoder, MiniMax)
    // plus any user-defined `agents` from config.json.
    for (const adapter of resolveAgentAdapters(agents)) this.register(adapter);
  }

  private register(adapter: CLIAdapter, fallbackName?: string): void {
    const name = fallbackName || adapter.name;
    this.adapters.set(name, adapter);
    // Only set displayName mapping if not already set (primary takes priority)
    if (!this.byDisplayName.has(adapter.displayName)) {
      this.byDisplayName.set(adapter.displayName, name);
    }
  }

  getNameByDisplayName(displayName: string): string | undefined {
    return this.byDisplayName.get(displayName);
  }

  async detectAvailable(): Promise<void> {
    this.available.clear();

    const checks = Array.from(this.adapters.entries()).map(
      async ([name, adapter]) => {
        const ok = await adapter.isAvailable();
        if (ok) {
          this.available.add(name);
          log.info(`  [ok] ${adapter.displayName}`);
        } else {
          log.warn(`  [--] ${adapter.displayName} 未安装`);
        }
      },
    );

    await Promise.all(checks);
  }

  get(name: string): CLIAdapter | undefined {
    if (this.available.has(name)) {
      return this.adapters.get(name);
    }
    // Check fallback chain
    const chain = this.fallbackChains.get(name);
    if (chain) {
      for (const fallback of chain) {
        if (this.available.has(fallback)) {
          log.info(`[${name}] SDK 不可用，回退到 CLI 模式`);
          return this.adapters.get(fallback);
        }
      }
    }
    return this.adapters.get(name);
  }

  isAvailable(name: string): boolean {
    if (this.available.has(name)) return true;
    // Check if any fallback in the chain is available
    const chain = this.fallbackChains.get(name);
    if (chain) {
      return chain.some(fallback => this.available.has(fallback));
    }
    return false;
  }

  getAvailableNames(): string[] {
    const names = new Set<string>();
    for (const name of this.available) {
      names.add(name);
    }
    // Also add primary names whose fallback is available
    for (const [primary, chain] of this.fallbackChains) {
      if (!this.available.has(primary) && chain.some(f => this.available.has(f))) {
        names.add(primary);
      }
    }
    return Array.from(names);
  }

  getAll(): CLIAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** Release long-lived adapter resources (e.g. background servers) on shutdown. */
  shutdown(): void {
    for (const adapter of this.adapters.values()) {
      try { adapter.close?.(); } catch { /* ignore */ }
    }
  }
}
