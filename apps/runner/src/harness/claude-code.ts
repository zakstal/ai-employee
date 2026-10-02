import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";

/**
 * Env vars that mark "this process is itself running inside a Claude Code
 * session" (set by Claude Code on itself). If we're forking a nested claude
 * process from within one (e.g. this runner invoked as a subagent in dev),
 * Claude Code refuses to start / behaves oddly. Strip them from the child env.
 */
const NESTED_SESSION_GUARD_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_EXECPATH",
] as const;

export interface ClaudeCodeOptions {
  prompt: string;
  maxTurns: number;
  systemPrompt?: string | undefined;
  allowedTools?: string | undefined;
  disallowedTools?: string | undefined;
  /** Raw MCP_CONFIG env value: JSON string `{"mcpServers":{...}}`. */
  mcpConfig?: string | undefined;
  model?: string | undefined;
  claudeBin?: string | undefined;
  workspaceDir?: string | undefined;
  /** Continue an earlier Claude Code session (`--resume`). Its transcript lives under $HOME/.claude/projects. */
  resumeSessionId?: string | undefined;
  onStderrLine?: ((line: string) => void) | undefined;
}

export function spawnClaudeCode(opts: ClaudeCodeOptions): ChildProcess {
  const bin = opts.claudeBin ?? "claude";
  const cwd = opts.workspaceDir ?? "/workspace";
  mkdirSync(cwd, { recursive: true });

  const argv = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    // default mode + --permission-prompts none: anything not in --allowedTools is DENIED, never prompted.
    // bypassPermissions would ignore the role allowlist entirely (observed: Bash ran with allowlist [Read,Grep,Glob]).
    "--permission-mode",
    process.env.PERMISSION_MODE ?? "default",
    "--permission-prompts",
    "none",
    "--max-turns",
    String(opts.maxTurns),
  ];
  if (opts.allowedTools) argv.push("--allowedTools", opts.allowedTools);
  if (opts.disallowedTools) argv.push("--disallowedTools", opts.disallowedTools);
  if (opts.systemPrompt) argv.push("--append-system-prompt", opts.systemPrompt);
  if (hasMcpServers(opts.mcpConfig)) argv.push("--mcp-config", opts.mcpConfig as string);
  if (opts.model) argv.push("--model", opts.model);
  if (opts.resumeSessionId) argv.push("--resume", opts.resumeSessionId);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of NESTED_SESSION_GUARD_VARS) delete env[key];
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";

  const child = spawn(bin, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

  if (child.stderr) {
    const stderrLines = createInterface({ input: child.stderr });
    stderrLines.on("line", (line) => {
      process.stderr.write(`[claude] ${line}\n`);
      opts.onStderrLine?.(line);
    });
  }

  return child;
}

function hasMcpServers(mcpConfig: string | undefined): boolean {
  if (!mcpConfig) return false;
  try {
    const parsed = JSON.parse(mcpConfig) as { mcpServers?: Record<string, unknown> };
    return Object.keys(parsed.mcpServers ?? {}).length > 0;
  } catch {
    return false;
  }
}
