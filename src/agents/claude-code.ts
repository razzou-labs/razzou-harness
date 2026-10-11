import { z } from 'zod';
import { ReportSchema } from '../design/schemas.ts';
import type { AttemptOutcome, Finding, Usage } from '../state/events.ts';
import { sh, tail } from '../util.ts';

/** Where one Developer run keeps its files inside the sandbox. */
export interface AgentRun {
  workDir: string;
  /** Role text, appended to the agent's own system prompt; never replacing it. */
  promptFile: string;
  /** The task, given on stdin. */
  taskFile: string;
  /** JSON Schema of the final report. */
  schemaFile: string;
  /** The harness MCP server: the shim that relays tool calls to the daemon. */
  mcpConfigFile: string;
  streamFile: string;
  stderrFile: string;
  exitFile: string;
  pidFile: string;
  sessionId: string;
  model: string;
  effort?: string;
}

/** One launch of the Manager: a long session fed from a file, so that it outlives the daemon (spike 1). */
export interface ManagerRun {
  workDir: string;
  promptFile: string;
  mcpConfigFile: string;
  /** Its permissions: read-only files and `git log/diff/show` (spike 3). */
  settingsFile: string;
  /** Each launch reads its own input file, from the start, so nothing written before it starts is lost. */
  inputFile: string;
  /** Shared by every launch: the whole conversation, for the dashboard. */
  outputFile: string;
  stderrFile: string;
  exitFile: string;
  pidFile: string;
  tailPidFile: string;
  /** The conversation: started by the first launch, resumed by later ones. */
  sessionId: string;
  model: string;
  effort?: string;
}

/** The Architect's interactive session, in the terminal the owner attaches to. */
export interface ArchitectRun {
  workDir: string;
  promptFile: string;
  mcpConfigFile: string;
  /** The first message of the conversation; later launches resume it. */
  welcomeFile: string;
  sessionId: string;
  model: string;
  effort?: string;
}

export interface AgentAdapter {
  readonly id: string;
  /**
   * A bash script that starts the agent in its own session and returns at once. The agent
   * outlives the `exec` that started it, and so the daemon, which follows its files instead.
   */
  launch(run: AgentRun): string;
  launchManager(run: ManagerRun): string;
  /** The Architect's launcher script: the sandbox's main command runs it in its terminal. */
  architectLauncher(run: ArchitectRun): string;
}

export interface AgentResult {
  outcome: AttemptOutcome;
  summary?: string;
  finding?: Finding;
  usage?: Usage;
  /** What the Developer wants the Manager to know. */
  notes?: string;
  detail?: string;
}

/** Built-in tools that act only inside the sandbox: no remote triggers, no cloud tasks. Harness tools come through MCP. */
const DEVELOPER_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,TodoWrite';
/** With `--restricted`, the settings limit Bash to `git log/diff/show`, plus Claude Code's own read-only commands inside the clone. */
const MANAGER_TOOLS = 'Read,Grep,Glob,Bash';
/** The Architect also delegates to subagents, uses skills such as grill-me, and asks the owner questions. */
const ARCHITECT_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Task,Skill,AskUserQuestion';

export const claudeCode: AgentAdapter = {
  id: 'claude-code',
  launch(run) {
    const args = [
      'claude', '-p',
      '--model', run.model,
      ...(run.effort ? ['--effort', run.effort] : []),
      '--append-system-prompt-file', run.promptFile,
      '--session-id', run.sessionId,
      '--permission-mode', 'bypassPermissions',
      '--tools', DEVELOPER_TOOLS,
      '--mcp-config', run.mcpConfigFile,
      '--strict-mcp-config',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    const claude = `${args.map(sh).join(' ')} --json-schema "$(cat ${sh(run.schemaFile)})"`;
    const body = [
      `echo $$ > ${sh(run.pidFile)}`,
      `${claude} < ${sh(run.taskFile)} > ${sh(run.streamFile)} 2> ${sh(run.stderrFile)}`,
      `echo $? > ${sh(run.exitFile)}`,
    ].join('\n');
    return detach(run.workDir, body);
  },

  launchManager(run) {
    const args = [
      'claude', '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--replay-user-messages',
      '--model', run.model,
      ...(run.effort ? ['--effort', run.effort] : []),
      '--append-system-prompt-file', run.promptFile,
      '--restricted',
      '--tools', MANAGER_TOOLS,
      '--settings', run.settingsFile,
      '--permission-mode', 'dontAsk',
      '--mcp-config', run.mcpConfigFile,
      '--strict-mcp-config',
    ];
    // The conversation is resumed if Claude Code saved it before ($HOME is /sandbox), and started otherwise.
    const session = `"$(ls "$HOME"/.claude/projects/*/${run.sessionId}.jsonl > /dev/null 2>&1 && echo --resume || echo --session-id)" ${sh(run.sessionId)}`;
    // tail follows the input file for as long as Claude runs, and is stopped when it ends.
    const input = `<(echo $BASHPID > ${sh(run.tailPidFile)}; exec tail -n +1 -s 0.2 -F ${sh(run.inputFile)})`;
    const body = [
      `echo $$ > ${sh(run.pidFile)}`,
      `${args.map(sh).join(' ')} ${session} < ${input} >> ${sh(run.outputFile)} 2> ${sh(run.stderrFile)}`,
      'code=$?',
      `kill "$(cat ${sh(run.tailPidFile)})" 2>/dev/null`,
      `echo $code > ${sh(run.exitFile)}`,
    ].join('\n');
    return detach(run.workDir, body);
  },

  architectLauncher: (run) => architectLauncher(run),
};

export function architectLauncher(run: ArchitectRun): string {
  const args = [
    'claude',
    '--model', run.model,
    ...(run.effort ? ['--effort', run.effort] : []),
    '--append-system-prompt-file', run.promptFile,
    '--permission-mode', 'bypassPermissions',
    '--tools', ARCHITECT_TOOLS,
    '--mcp-config', run.mcpConfigFile,
    '--strict-mcp-config',
  ].map(sh).join(' ');
  return [
    '#!/bin/bash',
    "# The Architect's terminal (proposal v2 §7.5, spike 4): Claude Code in a loop on one",
    '# conversation, so the sandbox never runs out of a main process. /exit restarts it.',
    `cd ${sh(run.workDir)} || exit 1`,
    'while true; do',
    `  if ls "$HOME"/.claude/projects/*/${run.sessionId}.jsonl > /dev/null 2>&1; then`,
    `    ${args} --resume ${sh(run.sessionId)}`,
    '  else',
    `    ${args} --session-id ${sh(run.sessionId)} "$(cat ${sh(run.welcomeFile)})"`,
    '  fi',
    '  sleep 2',
    'done',
    '',
  ].join('\n');
}

/** `~/.claude.json` with Claude Code's first-run screens answered, so the terminal opens on the conversation. */
export function claudeJson(workDir: string): string {
  return JSON.stringify({
    hasCompletedOnboarding: true,
    theme: 'dark',
    bypassPermissionsModeAccepted: true,
    projects: { [workDir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  });
}

/** The Architect's user settings: its messages join the owner's next prompt (§9.6). */
export function architectSettings(harnessDir: string): string {
  return JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `HARNESS_DIR=${sh(harnessDir)} node ${sh(`${harnessDir}/harness-mcp.mjs`)} inbox` }] }],
    },
  });
}

/** The harness MCP server for `--mcp-config`. Its tools are listed in `tools.json` beside it. */
export function mcpConfig(harnessDir: string): string {
  return JSON.stringify({
    mcpServers: {
      harness: { type: 'stdio', command: 'node', args: [`${harnessDir}/harness-mcp.mjs`], env: { HARNESS_DIR: harnessDir } },
    },
  });
}

/** The Manager's permissions with `dontAsk`: anything else is refused (spike 3), except read-only commands inside its clone. */
export function managerSettings(): string {
  return JSON.stringify({
    permissions: { allow: ['Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'mcp__harness'] },
  });
}

/** One message for a session reading `--input-format stream-json`. */
export function userMessage(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
}

/**
 * Starts `body` in its own session from `dir`. Only the simple command goes to the
 * background: `cd x && cmd &` would background the whole list, in a subshell that keeps
 * the exec's output open until the agent ends.
 */
export function detach(dir: string, body: string): string {
  return `cd ${sh(dir)} || exit 1\nsetsid nohup bash -c ${sh(body)} > /dev/null 2>&1 < /dev/null &`;
}

/**
 * The report's JSON Schema for `--json-schema`. Claude Code's validator doesn't know
 * the 2020-12 meta-schema zod points to by default, so this is draft 7 without `$schema`.
 */
export function reportJsonSchema(): string {
  const { $schema: _, ...schema } = z.toJSONSchema(ReportSchema, { target: 'draft-7' });
  return JSON.stringify(schema);
}

/**
 * Reads the outcome from the stream's final `result` event and its structured output.
 * Without one, the end of stderr says why: Claude Code reports a bad flag there.
 */
export function readResult(stream: string, exitCode: number, stderr = ''): AgentResult {
  let result: Record<string, unknown> | undefined;
  for (const line of stream.split('\n')) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'result') result = event;
    } catch {
      // A partial line from a killed process.
    }
  }
  if (!result) {
    const why = stderr.trim() === '' ? '' : `: ${tail(stderr.trim(), 500)}`;
    return { outcome: exitCode === 0 ? 'no_report' : 'error', detail: `the session ended without a result${why}` };
  }

  const usage = toUsage(result.usage, result.total_cost_usd);
  const text = typeof result.result === 'string' ? result.result : '';
  if (result.is_error === true && /usage limit|limit reached|rate.?limit/i.test(text)) {
    return { outcome: 'usage_limit', detail: text.slice(0, 500), usage };
  }
  const report = ReportSchema.safeParse(result.structured_output);
  if (!report.success) return { outcome: result.is_error === true ? 'error' : 'no_report', detail: text.slice(0, 500), usage };
  return { outcome: report.data.outcome, summary: report.data.summary, finding: report.data.finding, notes: report.data.notes, usage };
}

function toUsage(usage: unknown, cost: unknown): Usage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, number | undefined>;
  return {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    ...(typeof cost === 'number' ? { costUsd: cost } : {}),
  };
}
