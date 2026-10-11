import type { Check, Feature, Plan } from '../design/schemas.ts';
import type { Ref } from '../state/events.ts';
import type { Attempt } from '../state/state.ts';

export interface TaskInput {
  ref: Ref;
  plan: Plan;
  feature: Feature;
  /** The project's own checks and those of features already accepted: they must keep passing. */
  regressionChecks: Check[];
  previous?: Attempt;
  /** From the Manager after a failure, or from the owner after an escalation. */
  guidance?: string;
  progressTail: string;
}

/** The Developer's task, given on stdin. Its role text is appended to the system prompt separately. */
export function buildTask(input: TaskInput): string {
  const { ref, plan, feature } = input;
  const featureChecks = feature.checks.filter((c) => c.phase === 'pre-merge');
  const lines = [
    `# Feature ${ref.module}/${ref.plan}/${ref.feature}: ${feature.title}`,
    '',
    `You implement exactly one feature of the plan "${plan.title}" (module ${ref.module}). This is attempt ${ref.attempt}.`,
    '',
    '## The feature',
    '',
    feature.description,
    '',
    `**Expected result:** ${feature.expected}`,
  ];
  if (feature.resources.length > 0) lines.push('', `**Where to look:** ${feature.resources.join(', ')}`);
  if (featureChecks.length > 0) {
    lines.push(
      '',
      '## How it is checked',
      '',
      'After you finish, the harness runs these commands from the repository root, in a fresh sandbox. Each must exit 0. They fail now.',
      '',
      ...featureChecks.map((c) => `- \`${c.run}\` (${c.id})`),
    );
  } else {
    lines.push(
      '',
      '## How it is checked',
      '',
      "CI is the check: after you finish, the harness runs the checks below in a fresh sandbox, then pushes your commits and CI runs again on the pull request. The failure above may not reproduce here; reason from CI's output.",
    );
  }
  if (input.regressionChecks.length > 0) {
    lines.push('', 'These already pass and must keep passing:', '', ...input.regressionChecks.map((c) => `- \`${c.run}\` (${c.id})`));
  }
  if (input.previous) {
    lines.push('', '## The previous attempt', '', `It failed: ${input.previous.reason ?? input.previous.outcome ?? 'unknown reason'}.`);
    for (const check of (input.previous.checks ?? []).filter((c) => c.exit !== 0)) {
      lines.push('', `\`${check.id}\` exited ${check.exit}:`, '', '```', check.output.trim(), '```');
    }
  }
  if (input.guidance) {
    lines.push('', '## Guidance for this attempt', '', input.guidance.trim());
  }
  if (input.progressTail.trim() !== '') {
    lines.push('', '## Progress so far', '', '```', input.progressTail.trimEnd(), '```');
  }
  lines.push(
    '',
    '## When you finish',
    '',
    'Commit your work with a meaningful message. Uncommitted changes are discarded.',
    'End with your structured report: `done` with a short summary, or `blocked` with a finding when you cannot finish.',
    'If a decision is open that the task and the repository do not settle, ask the Manager with `ask_manager` before you guess.',
  );
  return `${lines.join('\n')}\n`;
}
