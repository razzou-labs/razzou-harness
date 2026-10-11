// A fake Manager for tests. It reads its input file the way Claude Code reads
// `--input-format stream-json`, and answers each `[harness]` item by appending a tool call
// to the outbox, as the shim would. Run with node; it has no imports from the harness.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export interface ManagerBehavior {
  /** Attempts to reject, like "demo/P1/F02#1". */
  reject?: string[];
  /** The answer to every question. */
  answer?: string;
  /** On a failed attempt, ask the owner first and retry with the answer. */
  askOwner?: boolean;
  /** On a failed attempt, ask the Architect first and retry with its decision. */
  escalate?: boolean;
  /** Item kinds to ignore, like "REVIEW", to test the turn brake. */
  ignore?: string[];
  /** Exit after this many items, in the first launch only, to test relaunches. */
  exitAfter?: number;
  /** Exit at once with an error and no output, like Claude Code with a bad flag. */
  failStart?: boolean;
}

const { values } = parseArgs({
  options: { input: { type: 'string' }, output: { type: 'string' }, outbox: { type: 'string' }, launch: { type: 'string' }, behavior: { type: 'string' } },
});
const input = values.input!;
const behavior = JSON.parse(values.behavior ?? '{}') as ManagerBehavior;
const firstLaunch = values.launch === '1';

if (behavior.failStart) {
  process.stderr.write('Error: unknown option --stub-bad-flag\n');
  process.exit(1);
}

const out = (event: object) => appendFileSync(values.output!, `${JSON.stringify(event)}\n`);
const say = (text: string) => out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const call = (tool: string, args: object) => {
  appendFileSync(values.outbox!, `${JSON.stringify({ v: 1, id: randomUUID(), ts: new Date().toISOString(), tool, args })}\n`);
  say(`called ${tool}`);
};

out({ type: 'system', subtype: 'init' });
let offset = 0;
let handled = 0;
setInterval(() => {
  // The sandbox was removed: nothing more to do.
  if (!existsSync(input)) process.exit(0);
  const text = readFileSync(input, 'utf8');
  if (text.length <= offset) return;
  const end = text.lastIndexOf('\n') + 1;
  const lines = text.slice(offset, end).split('\n').filter((line) => line.trim() !== '');
  offset = end;
  for (const line of lines) {
    const content = (JSON.parse(line) as { message: { content: string } }).message.content;
    out({ type: 'user', message: { role: 'user', content } });
    act(content);
    handled += 1;
    if (firstLaunch && behavior.exitAfter && handled >= behavior.exitAfter) process.exit(0);
  }
}, 50);

function act(item: string): void {
  const header = item.split('\n')[0]!;
  const kind = /^\[harness\] (\w+)/.exec(header)?.[1] ?? '';
  if (behavior.ignore?.includes(kind)) return;
  let m: RegExpExecArray | null;
  if ((m = /^\[harness\] QUESTION .* \(question_id: ([^)]+)\)/.exec(header))) {
    call('answer_developer', { question_id: m[1], answer: behavior.answer ?? 'Use the simplest option.' });
  } else if ((m = /^\[harness\] REVIEW (\S+) attempt (\d+)/.exec(header))) {
    const id = `${m[1]}#${m[2]}`;
    if (behavior.reject?.includes(id)) {
      call('reject_feature', { feature: m[1], attempt: Number(m[2]), guidance: `Stub guidance: redo ${id} properly this time.` });
    } else {
      call('accept_feature', { feature: m[1], attempt: Number(m[2]) });
    }
  } else if ((m = /^\[harness\] ATTEMPT FAILED (\S+) attempt (\d+)/.exec(header))) {
    if (behavior.askOwner) call('ask_owner', { question: `How should ${m[1]} be done?`, blocking: true });
    else if (behavior.escalate) call('escalate_to_architect', { question: `How should ${m[1]} be done?`, feature: m[1] });
    else call('retry_feature', { feature: m[1], guidance: `Stub guidance after attempt ${m[2]}: read the failing check first.` });
  } else if ((m = /^\[harness\] (ANSWER from the owner|DECISION from the Architect)/.exec(header))) {
    const feature = /You asked: How should (\S+) be done\?/.exec(item)?.[1];
    const answer = /\n(?:Answer|Decision): ([\s\S]*)$/.exec(item)?.[1] ?? '';
    if (feature) call('retry_feature', { feature, guidance: `The ${m[1]!.startsWith('ANSWER') ? 'owner' : 'Architect'} says: ${answer}` });
  } else if ((m = /^\[harness\] (?:DEPLOY FAILED|POST-DEPLOY CHECKS FAILED) (\S+)/.exec(header))) {
    call('request_fix', { plan: m[1], guidance: 'Stub diagnosis: the deployed infrastructure is incomplete; add what the check looks for.' });
  } else if ((m = /^\[harness\] CI FAILED (\S+)/.exec(header))) {
    call('request_fix', { plan: m[1], guidance: 'Stub diagnosis: the checks job fails; make it pass.' });
  } else if ((m = /^\[harness\] PLAN READY (\S+)/.exec(header))) {
    call('submit_plan', { plan: m[1], summary: 'Stub summary of the plan.' });
  } else {
    say('noted');
  }
}
