import { z } from 'zod';

/** The agents the harness runs. */
export type Role = 'developer' | 'manager' | 'architect';

/** Who says something, in a message. */
export type Party = Role | 'owner' | 'daemon';

const FeatureKey = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/, 'module/plan/feature, like "orders/P2/F07"');
const PlanKey = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/, 'module/plan, like "orders/P2"');
const AttemptNumber = z.number().int().positive();
const Guidance = z.string().trim().min(20, 'say in at least a sentence what the next Developer should do differently').max(8000);

/** The arguments of every harness tool. The daemon validates each call against these. */
export const INPUTS = {
  ask_manager: z.object({ question: z.string().trim().min(1).max(4000) }),
  web_read: z.object({ url: z.url({ protocol: /^https?$/ }) }),
  answer_developer: z.object({ question_id: z.string().min(1), answer: z.string().trim().min(1).max(8000) }),
  accept_feature: z.object({ feature: FeatureKey, attempt: AttemptNumber, note: z.string().max(2000).optional() }),
  reject_feature: z.object({ feature: FeatureKey, attempt: AttemptNumber, guidance: Guidance }),
  retry_feature: z.object({ feature: FeatureKey, guidance: Guidance }),
  abort_attempt: z.object({ feature: FeatureKey, attempt: AttemptNumber, reason: z.string().trim().min(1).max(2000) }),
  ask_owner: z.object({ question: z.string().trim().min(1).max(8000), blocking: z.boolean() }),
  submit_plan: z.object({ plan: PlanKey, summary: z.string().trim().min(1).max(8000) }),
  get_state: z.object({}),
  get_attempt: z.object({ feature: FeatureKey, attempt: AttemptNumber }),
  get_ci_results: z.object({ plan: PlanKey }),
  request_fix: z.object({ plan: PlanKey, guidance: Guidance }),
  escalate_to_architect: z.object({ question: z.string().trim().min(1).max(8000), feature: FeatureKey.optional() }),
  submit_proposal: z.object({ version: z.number().int().positive() }),
  submit_design: z.object({ summary: z.string().trim().min(1).max(8000) }),
  get_inbox: z.object({}),
  reply_to_manager: z.object({ escalation_id: z.string().min(1), decision: z.string().trim().min(1).max(8000) }),
};

export type ToolName = keyof typeof INPUTS;
export type ToolInput<T extends ToolName> = z.infer<(typeof INPUTS)[T]>;

/**
 * A harness tool, as the agent sees it through the MCP shim. The daemon validates the
 * arguments and answers; the shim only relays.
 */
export interface ToolSpec {
  name: ToolName;
  description: string;
  /** How long the agent's call waits for the daemon's reply. */
  waitSec: number;
  /** What the agent is told when no reply comes in time. */
  onTimeout?: string;
}

const webRead: ToolSpec = {
  name: 'web_read',
  description:
    'Reads a public web page with GET and returns it as text, at most 100 kB. Use it for documentation on sites the sandbox cannot reach directly. Local and private addresses are refused.',
  waitSec: 90,
};

export const TOOLS: Record<Role, ToolSpec[]> = {
  developer: [
    {
      name: 'ask_manager',
      description:
        'Asks the Manager about the feature or the design, and waits for the answer (at most 15 minutes). Ask only what the task and the repository do not settle.',
      waitSec: 900,
      onTimeout: 'No answer came within 15 minutes. Finish with a blocked report that says what you needed.',
    },
    webRead,
  ],
  manager: [
    { name: 'answer_developer', description: "Answers a Developer's question. Your answer becomes the result of its ask_manager call.", waitSec: 120 },
    {
      name: 'accept_feature',
      description: 'Accepts an attempt you reviewed. The daemon lands it on the plan branch as one commit. Only possible once its checks passed.',
      waitSec: 120,
    },
    {
      name: 'reject_feature',
      description: 'Rejects an attempt you reviewed. It counts as failed, and the next attempt starts with your guidance, if attempts remain.',
      waitSec: 120,
    },
    {
      name: 'retry_feature',
      description:
        'After a failed attempt, starts the next one with your guidance. The next Developer starts fresh: it sees the feature, why the last attempt failed, and your guidance.',
      waitSec: 120,
    },
    { name: 'abort_attempt', description: 'Stops the running attempt. It counts as failed. Use it only when the attempt cannot succeed.', waitSec: 120 },
    {
      name: 'ask_owner',
      description: 'Asks the owner in the dashboard. The answer arrives later, as a message. With blocking: true, no new attempt starts until the owner answers.',
      waitSec: 120,
    },
    {
      name: 'submit_plan',
      description:
        'Submits a plan once all its features are accepted and its full check run passed. Your summary becomes the description of its pull request.',
      waitSec: 120,
    },
    { name: 'get_state', description: "The module's plans, features and attempts, with their status, open questions and requests to the owner.", waitSec: 60 },
    { name: 'get_attempt', description: 'One attempt in detail: its task, report, check results, questions and outcome.', waitSec: 60 },
    {
      name: 'get_ci_results',
      description: "A plan's pull request and its latest CI: each required job's conclusion, and the end of each failed job's log.",
      waitSec: 60,
    },
    {
      name: 'request_fix',
      description:
        "After CI failed on a plan's pull request, starts a fix round: a Developer fixes it on the plan branch, guided by your diagnosis, then CI runs again. A pull request gets a limited number of rounds.",
      waitSec: 120,
    },
    {
      name: 'escalate_to_architect',
      description:
        'Asks the Architect about the design: a contradiction, a decision it left open, a check that tests the wrong thing. The owner sees it too. The Architect answers when the owner next works with it, so plan for a wait.',
      waitSec: 120,
    },
    webRead,
  ],
  architect: [
    {
      name: 'submit_proposal',
      description:
        'Submits proposal vN, written in harness/modules/<module>/proposals/v<N>.md in your clone. The owner reads it in the dashboard, then accepts it there or tells you what to change.',
      waitSec: 120,
    },
    {
      name: 'submit_design',
      description:
        "Submits the design committed on your branch. The daemon validates it, runs its new checks once (they should fail, as nothing is built yet), hashes the protected files, and opens the Arch PR. You get the problems to fix, or the PR's link.",
      waitSec: 1800,
      onTimeout: 'The harness is still working on your design. Its answer will come as a message with your next prompt; get_inbox shows it too.',
    },
    { name: 'get_state', description: "Your module: its status, proposals, design PR, plans and features, and open questions from the Manager.", waitSec: 60 },
    { name: 'get_inbox', description: 'Your messages: questions from the Manager and notes from the harness, newest last.', waitSec: 60 },
    { name: 'reply_to_manager', description: "Answers one of the Manager's escalations. Your decision reaches it at once.", waitSec: 120 },
    webRead,
  ],
};

/** `tools.json` for the shim: names, descriptions, JSON Schemas and waits. */
export function toolsManifest(role: Role): string {
  return JSON.stringify(
    TOOLS[role].map((tool) => {
      const { $schema: _, ...inputSchema } = z.toJSONSchema(INPUTS[tool.name], { target: 'draft-7', io: 'input' });
      return { name: tool.name, description: tool.description, inputSchema, waitSec: tool.waitSec, onTimeout: tool.onTimeout };
    }),
  );
}
