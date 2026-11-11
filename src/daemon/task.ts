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
  /** Set for a merge round: main at that commit conflicts with the plan branch in `files`. */
  merge?: { main: string; files: string[] };
}

/** The Developer's task, given on stdin. Its role text is appended to the system prompt separately. */
export function buildTask(input: TaskInput): string {
  const lines = input.merge ? mergeLines(input, input.merge) : featureLines(input);
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

/** What a feature's task opens with: the feature, how it is checked, and what must keep passing. */
function featureLines(input: TaskInput): string[] {
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
  return lines;
}

/**
 * A merge round's task (v3 §6.6): main conflicts with the plan branch, and a Developer
 * merges it by hand. The clone is on the plan branch, with `main` at the commit to merge.
 */
function mergeLines(input: TaskInput, merge: { main: string; files: string[] }): string[] {
  const { ref, plan, feature } = input;
  return [
    `# Feature ${ref.module}/${ref.plan}/${ref.feature}: ${feature.title}`,
    '',
    `You merge \`main\` into the branch of the plan "${plan.title}" (module ${ref.module}), and write no feature. This is attempt ${ref.attempt}.`,
    '',
    '## The merge',
    '',
    'Since this plan started, other work was merged into `main`, and git can no longer merge it into the plan branch: both sides changed the same lines in',
    '',
    ...merge.files.map((file) => `- \`${file}\``),
    '',
    `Your clone is on the plan branch, and \`main\` is a local branch at the commit to merge (${merge.main.slice(0, 8)}). Run \`git merge main\`, resolve every conflict, and commit the merge.`,
    '',
    '- **Keep the work of both sides.** What `main` brought was accepted and merged, and what the plan branch holds was accepted too. A resolution that drops the behavior of either is wrong, even when every check passes.',
    '- **Read both sides before you choose.** `git log --oneline HEAD..main` lists what `main` gained. For a file, `git diff HEAD...main -- <file>` shows what `main` did to it since the two diverged, and `git diff main...HEAD -- <file>` what the plan did.',
    '- **Change nothing else.** No refactoring and no new behavior. Touch a file that did not conflict only when the merge needs it, such as a caller that must follow a function one side renamed.',
    "- **The design and the checks are `main`'s.** Everything under `harness/`, and every other protected file, must come out exactly as on `main`: take `main`'s version if git stops on one.",
    '- **Leave `progress.txt` alone.** Git merges it by itself here, and the harness writes it when your merge lands.',
    '',
    '## How it is checked',
    '',
    'After you finish, the harness runs these commands on your merge, from the repository root, in a fresh sandbox. They are the checks of everything accepted on both sides, and each must exit 0:',
    '',
    ...(input.regressionChecks.length > 0 ? input.regressionChecks.map((c) => `- \`${c.run}\` (${c.id})`) : ['- (the project has none yet)']),
    '',
    'Then the Manager reviews the merge: that both sides hold in the files that conflicted, and that nothing else changed.',
  ];
}
