// A fake Architect for tests. The real one talks with the owner in a terminal; this one
// plays the outcome: it proposes, waits for the owner's acceptance in its inbox, commits a
// design and submits it, resubmits a fix if refused, and answers escalations.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

export interface ArchitectBehavior {
  module: string;
  proposal?: string;
  /** Files written once a proposal is accepted, relative to the repository root. */
  design: Record<string, string>;
  summary?: string;
  /** Written and resubmitted if the first design is refused. */
  fix?: Record<string, string>;
  /** The answer to every escalation. */
  decision?: string;
  /** Written and submitted as a design change on the first escalation, before the answer. */
  change?: Record<string, string>;
}

const { values } = parseArgs({ options: { harness: { type: 'string' }, work: { type: 'string' }, behavior: { type: 'string' } } });
const harness = values.harness!;
const work = values.work!;
const behavior = JSON.parse(values.behavior!) as ArchitectBehavior;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function write(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
}

function commit(message: string): void {
  spawnSync('git', ['add', '-A'], { cwd: work });
  spawnSync('git', ['commit', '--quiet', '-m', message], { cwd: work });
}

async function call(tool: string, args: object, waitMs = 120_000): Promise<{ ok: boolean; text: string }> {
  const id = randomUUID();
  appendFileSync(join(harness, 'outbox.jsonl'), `${JSON.stringify({ v: 1, id, ts: new Date().toISOString(), tool, args })}\n`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const inbox = join(harness, 'inbox.jsonl');
    const line = existsSync(inbox) ? readFileSync(inbox, 'utf8').split('\n').find((l) => l.includes(`"replyTo":"${id}"`)) : undefined;
    if (line) return JSON.parse(line) as { ok: boolean; text: string };
    await sleep(100);
  }
  return { ok: false, text: 'no reply' };
}

function notes(): string[] {
  const file = join(harness, 'architect-inbox.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
}

const proposalPath = `harness/modules/${behavior.module}/proposals/v1.md`;
write({ [proposalPath]: behavior.proposal ?? `# ${behavior.module} v1\n\nA small design.\n` });
await call('submit_proposal', { version: 1 });
while (!notes().some((n) => n.includes('accepted proposal v1'))) await sleep(100);

write(behavior.design);
commit('Design');
const summary = behavior.summary ?? `The design of ${behavior.module}`;
let result = await call('submit_design', { summary });
if (!result.ok && behavior.fix) {
  write(behavior.fix);
  commit('Fix the design');
  result = await call('submit_design', { summary });
}

const answered = new Set<string>();
for (;;) {
  for (const note of notes()) {
    const id = /escalation ([\w-]+)/.exec(note)?.[1];
    if (id && !answered.has(id)) {
      if (behavior.change && answered.size === 0) {
        write(behavior.change);
        commit('Change the design');
        await call('submit_design', { summary: 'Fix a check' });
      }
      answered.add(id);
      await call('reply_to_manager', { escalation_id: id, decision: behavior.decision ?? 'Keep the design as it is.' });
    }
  }
  await sleep(200);
}
