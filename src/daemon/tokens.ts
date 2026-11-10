import type { AgentReading } from '../state/events.ts';
import { sh } from '../util.ts';
import type { Orchestrator } from './orchestrator.ts';

/**
 * Sums, in the sandbox, the tokens of every conversation Claude Code saved under
 * `$HOME/.claude/projects`: its subagents' and a relaunch's included. A reply is written
 * over several lines that share its id, so each id counts once, with its final count;
 * a line that doesn't parse, like the one being written, is skipped. Input counts the
 * prompt cache's tokens, written and read, as `toUsage` does for a Developer, and the
 * cache's reads apart too.
 *
 * The active time is the time the agent spent on its prompts (0.5.1): each turn, from a
 * prompt, the owner's, a note's or an item's, to its last step, a reply of Claude's or a
 * tool's result, before the next prompt. What Claude Code adds itself starts no turn and
 * ends none: it writes a queued message's line when the message comes, hours later for an
 * idle agent. A subagent works within its caller's turn, which its result ends, so its
 * conversation counts no time; and a conversation resumed in a new file repeats the old
 * one's turns, so they count once.
 *
 * A file that can't be read fails the whole reading rather than give a short one, which
 * the daemon would take for a new sandbox and count again.
 */
const COUNT = `
const fs = require('fs'), path = require('path');
const replies = new Map();
const turns = [];
const toolResult = (entry) => Array.isArray(entry.message.content) && entry.message.content.some((block) => block && block.type === 'tool_result');
const prompt = (entry) => entry.type === 'user' && !entry.isMeta && !entry.isCompactSummary && !!entry.message && !toolResult(entry);
const step = (entry) => entry.type === 'assistant' || (entry.type === 'user' && !!entry.message && toolResult(entry));
const read = (file, subagent) => {
  let start, last;
  for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    const message = entry.type === 'assistant' ? entry.message : undefined;
    if (message && message.id && message.usage) {
      const u = message.usage;
      const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const output = u.output_tokens || 0;
      const seen = replies.get(message.id);
      if (!seen || output > seen[1]) replies.set(message.id, [input, output, u.cache_read_input_tokens || 0]);
    }
    if (subagent || entry.isSidechain) continue;
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at)) continue;
    if (prompt(entry)) {
      if (start !== undefined) turns.push([start, last]);
      start = last = at;
    } else if (start !== undefined && step(entry)) last = at;
  }
  if (start !== undefined) turns.push([start, last]);
};
const walk = (dir, subagent) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, item.name);
    if (item.isDirectory()) walk(next, subagent || item.name === 'subagents');
    else if (item.name.endsWith('.jsonl')) read(next, subagent);
  }
};
const root = path.join(process.env.HOME, '.claude', 'projects');
if (fs.existsSync(root)) walk(root, false);
let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0;
for (const [input, output, cache] of replies.values()) { inputTokens += input; outputTokens += output; cacheReadTokens += cache; }
let activeMs = 0, end = -Infinity;
for (const [from, to] of turns.sort((a, b) => a[0] - b[0])) {
  if (to <= end) continue;
  activeMs += to - Math.max(from, end);
  end = to;
}
process.stdout.write(JSON.stringify({ inputTokens, outputTokens, cacheReadTokens, activeMs }));
`;

/** What a long-lived agent has used of Claude so far, and the time it worked, from its sandbox; undefined when it can't be read. */
export async function readTokens(o: Orchestrator, sandbox: string): Promise<AgentReading | undefined> {
  const result = await o.exec(sandbox, `node -e ${sh(COUNT)}`).catch(() => undefined);
  if (result?.code !== 0) return undefined;
  try {
    const reading = JSON.parse(result.stdout) as Partial<AgentReading>;
    const fields = [reading.inputTokens, reading.outputTokens, reading.cacheReadTokens, reading.activeMs];
    if (!fields.every((n) => Number.isFinite(n))) return undefined;
    return { inputTokens: reading.inputTokens!, outputTokens: reading.outputTokens!, cacheReadTokens: reading.cacheReadTokens!, activeMs: reading.activeMs! };
  } catch {
    return undefined;
  }
}
