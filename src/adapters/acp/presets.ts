import type { AcpPreset } from './adapter.js';

/**
 * Built-in ACP presets. Each launch line is taken from the agent's official docs and/or its
 * entry in the ACP registry (github.com/agentclientprotocol/registry, snapshot
 * cdn.agentclientprotocol.com/registry/v1/latest/registry.json, 2026-10-23), cross-checked
 * against acpx 0.21.0's built-in agent table. The registry launches via `npx <pkg>@<ver>`;
 * we call the installed binary instead (the bin name from the npm package).
 *
 * None of these were smoke-tested against a real CLI. `modeIds` are only filled in where the
 * mode ids were read from the agent's own published source/docs.
 */
export const ACP_PRESETS: AcpPreset[] = [
  {
    // Registry `qwen-code` (@qwen-code/qwen-code@0.26.0, args ["--acp", "--experimental-skills"]);
    // acpx: `qwen --acp`. `--acp` and the mode ids below verified in the 0.26.0 bundle
    // (APPROVAL_MODES = plan | default | auto-edit | auto | yolo). We omit the registry's
    // `--experimental-skills` flag: experimental flags tend to disappear between releases.
    name: 'qwen', displayName: 'Qwen Code', command: 'qwen', args: ['--acp'],
    modeIds: { auto: 'yolo', safe: 'default', plan: 'plan' },
  },
  {
    // Docs: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
    // (`copilot --acp --stdio`; stdio is the default transport; ACP is public preview).
    // Registry `github-copilot-cli`: @github/copilot `--acp`. Mode ids not documented.
    name: 'copilot', displayName: 'GitHub Copilot CLI', command: 'copilot', args: ['--acp', '--stdio'],
  },
  {
    // Docs: https://cursor.com/docs/cli/acp (`agent acp`; modes agent | plan | ask).
    // Registry `cursor` and acpx launch the same binary as `cursor-agent acp`; we use the
    // `cursor-agent` name because a bare `agent` on PATH is too generic to detect reliably.
    name: 'cursor', displayName: 'Cursor CLI', command: 'cursor-agent', args: ['acp'],
    modeIds: { auto: 'agent', safe: 'agent', plan: 'plan' },
  },
  {
    // Registry `codebuddy-code`: @tencent-ai/codebuddy-code@2.174.0 `--acp` (bin `codebuddy`).
    // `--acp` and the ACP mode ids (default | acceptEdits | plan | auto | dontAsk |
    // bypassPermissions | fullAccess) verified in the 2.174.0 bundle.
    name: 'codebuddy', displayName: 'CodeBuddy Code', command: 'codebuddy', args: ['--acp'],
    modeIds: { auto: 'bypassPermissions', safe: 'default', plan: 'plan' },
  },
  {
    // Docs: https://docs.factory.com/droid-exec/overview (`--output-format` accepts `acp`);
    // acpx: `droid exec --output-format acp`. NOTE the registry `factory-droid` entry uses
    // `--output-format acp-daemon` instead — not verified which one newer builds prefer.
    // Env vars from the registry entry keep the auto-updater quiet under an ACP client.
    name: 'droid', displayName: 'Factory Droid', command: 'droid', args: ['exec', '--output-format', 'acp'],
    env: { DROID_DISABLE_AUTO_UPDATE: 'true', FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
  },
  {
    // Docs: https://docs.devin.ai/cli/reference/commands (`devin acp`; reads WINDSURF_API_KEY
    // or `devin auth login` credentials). Registry `devin` and acpx: `devin acp`.
    name: 'devin', displayName: 'Devin CLI', command: 'devin', args: ['acp'],
  },
  {
    // Registry `qoder`: @qoder-ai/qodercli `--acp`; acpx: `qodercli --acp`. Docs
    // (https://docs.qoder.com/en/cli/acp) call the binary `qoder`; the npm package ships both
    // `qoder` and `qodercli`. Login first (`qoder login` or QODER_PERSONAL_ACCESS_TOKEN).
    name: 'qoder', displayName: 'Qoder CLI', command: 'qodercli', args: ['--acp'],
  },
  {
    // README https://github.com/MiniMax-AI/minimax-code (`mcode acp`); registry `minimax-code`
    // (@minimax-ai/code `acp`); acpx: `mcode acp`.
    name: 'minimax', displayName: 'MiniMax Code', command: 'mcode', args: ['acp'],
  },
];
