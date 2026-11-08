import type { Usage } from '../state/events.ts';
import { sh } from '../util.ts';
import type { Orchestrator } from './orchestrator.ts';

/**
 * Sums, in the sandbox, the tokens of every conversation Claude Code saved under
 * `$HOME/.claude/projects`: its subagents' and a relaunch's included. A reply is written
 * over several lines that share its id, so each id counts once, with its final count;
 * a line that doesn't parse, like the one being written, is skipped. Input counts the
 * prompt cache's tokens, written and read, as `toUsage` does for a Developer.
 */
const COUNT = `
const fs = require('fs'), path = require('path');
const replies = new Map();
const read = (file) => {
  for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry && entry.type === 'assistant' ? entry.message : undefined;
    if (!message || !message.id || !message.usage) continue;
    const u = message.usage;
    const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const output = u.output_tokens || 0;
    const seen = replies.get(message.id);
    if (!seen || output > seen[1]) replies.set(message.id, [input, output]);
  }
};
const walk = (dir) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, item.name);
    if (item.isDirectory()) walk(next);
    else if (item.name.endsWith('.jsonl')) read(next);
  }
};
try { walk(path.join(process.env.HOME, '.claude', 'projects')); } catch {}
let inputTokens = 0, outputTokens = 0;
for (const [input, output] of replies.values()) { inputTokens += input; outputTokens += output; }
process.stdout.write(JSON.stringify({ inputTokens, outputTokens }));
`;

/** What a long-lived agent has used of Claude so far, from its sandbox; undefined when it can't be read. */
export async function readTokens(o: Orchestrator, sandbox: string): Promise<Usage | undefined> {
  const result = await o.exec(sandbox, `node -e ${sh(COUNT)}`).catch(() => undefined);
  if (result?.code !== 0) return undefined;
  try {
    const usage = JSON.parse(result.stdout) as Partial<Usage>;
    return Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens) ? { inputTokens: usage.inputTokens!, outputTokens: usage.outputTokens! } : undefined;
  } catch {
    return undefined;
  }
}
