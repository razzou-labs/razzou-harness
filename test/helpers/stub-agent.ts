import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detach, type AgentAdapter, type AgentRun, type ArchitectRun, type ManagerRun } from '../../src/agents/claude-code.ts';
import { sh } from '../../src/util.ts';
import type { ArchitectBehavior } from './stub-architect.ts';
import type { ManagerBehavior } from './stub-manager.ts';

export interface StubBehavior {
  /** Files to write, relative to the repository root. */
  files?: Record<string, string>;
  outcome?: 'done' | 'blocked';
  commit?: boolean;
  sleepSec?: number;
  /** Ends without a result event, like a crashed session. */
  noResult?: boolean;
  /** Exits at once with an error and no output, like Claude Code with a bad flag. */
  crashAtStart?: boolean;
  /** Asks the Manager first, and commits its answer as `answer.txt`. */
  ask?: string;
}

/**
 * A fake Developer and Manager for tests. The Developer reads which feature and attempt
 * it is from the task, asks `decide` what to do, then writes files, commits, and ends with
 * a `result` line shaped like Claude Code's stream-json output. The Manager is
 * `stub-manager.ts`, run with `behavior`.
 */
export function stubAgent(
  decide: (feature: string, attempt: number) => StubBehavior,
  manager: ManagerBehavior = {},
  architect?: ArchitectBehavior,
): AgentAdapter {
  return {
    id: 'stub',
    launch(run: AgentRun) {
      const task = readFileSync(run.taskFile, 'utf8');
      const feature = /^# Feature [^/]+\/[^/]+\/([^:]+):/m.exec(task)?.[1] ?? '?';
      const attempt = Number(/This is attempt (\d+)\./.exec(task)?.[1] ?? 0);
      const behavior = decide(feature, attempt);
      const outcome = behavior.outcome ?? 'done';
      const result = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: `stub ${outcome}`,
        structured_output: outcome === 'done'
          ? { outcome, summary: `stub implemented ${feature}` }
          : { outcome, summary: `stub blocked on ${feature}`, finding: { category: 'spec_gap', summary: 'stub cannot proceed', tried: [], needs: 'a decision' } },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      const steps = [`echo $$ > ${sh(run.pidFile)}`];
      if (behavior.crashAtStart) {
        steps.push(`: > ${sh(run.streamFile)}`, `echo 'Error: unknown option --stub-bad-flag' > ${sh(run.stderrFile)}`, `echo 1 > ${sh(run.exitFile)}`);
        return detach(run.workDir, steps.join('\n'));
      }
      if (behavior.ask) steps.push(...askManager(dirname(run.mcpConfigFile), behavior.ask));
      if (behavior.sleepSec) steps.push(`sleep ${behavior.sleepSec}`);
      for (const [path, content] of Object.entries(behavior.files ?? {})) {
        steps.push(`mkdir -p "$(dirname ${sh(path)})"`, `printf %s ${sh(content)} > ${sh(path)}`);
      }
      if (behavior.commit ?? true) steps.push(`git add -A && git commit --quiet --allow-empty -m ${sh(`stub: ${feature}`)}`);
      if (behavior.noResult) {
        steps.push(`echo 1 > ${sh(run.exitFile)}`);
      } else {
        steps.push(`printf '%s\\n' ${sh(JSON.stringify(result))} > ${sh(run.streamFile)}`, `echo 0 > ${sh(run.exitFile)}`);
      }
      return detach(run.workDir, steps.join('\n'));
    },

    launchManager(run: ManagerRun) {
      const script = join(import.meta.dirname, 'stub-manager.ts');
      const launch = /launch-(\d+)\//.exec(run.inputFile)?.[1] ?? '1';
      const outbox = join(dirname(run.mcpConfigFile), 'outbox.jsonl');
      const body = [
        `echo $$ > ${sh(run.pidFile)}`,
        `node ${sh(script)} --input ${sh(run.inputFile)} --output ${sh(run.outputFile)} --outbox ${sh(outbox)} --launch ${launch} --behavior ${sh(JSON.stringify(manager))} 2> ${sh(run.stderrFile)}`,
        `echo $? > ${sh(run.exitFile)}`,
      ].join('\n');
      return detach(run.workDir, body);
    },

    architectLauncher(run: ArchitectRun) {
      const script = join(import.meta.dirname, 'stub-architect.ts');
      return [
        '#!/bin/bash',
        `cd ${sh(run.workDir)} || exit 1`,
        `exec node ${sh(script)} --harness ${sh(dirname(run.promptFile))} --work ${sh(run.workDir)} --behavior ${sh(JSON.stringify(architect ?? { module: '?', design: {} }))}`,
        '',
      ].join('\n');
    },
  };
}

/** What the shim does for an `ask_manager` call: a request line in the outbox, then wait for the reply in the inbox. */
function askManager(harnessDir: string, question: string): string[] {
  const id = randomUUID();
  const request = JSON.stringify({ v: 1, id, ts: new Date().toISOString(), tool: 'ask_manager', args: { question } });
  const extract = 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.stdout.write(s?JSON.parse(s).text:"(no answer)"))';
  return [
    `printf '%s\\n' ${sh(request)} >> ${sh(`${harnessDir}/outbox.jsonl`)}`,
    `for i in $(seq 1 300); do reply="$(grep -F ${sh(`"replyTo":"${id}"`)} ${sh(`${harnessDir}/inbox.jsonl`)} 2>/dev/null)" && break; sleep 0.1; done`,
    `printf '%s' "$reply" | node -e ${sh(extract)} > answer.txt`,
  ];
}
