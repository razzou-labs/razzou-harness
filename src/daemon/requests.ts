import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { describeOwnerTime } from '../design/owner-time.ts';
import { INPUTS, TOOLS, type Role, type ToolInput, type ToolName } from '../roles.ts';
import { activeAttempts, attemptInSandbox, featureKey, managerKey, planKey, type Attempt, type FeatureState } from '../state/state.ts';
import { clip, sh, sha256, tail } from '../util.ts';
import type { AgentRequest } from './channel.ts';
import { isBuilt } from './design.ts';
import { attemptsLeft, checksFail, checksReport, ciReport, conflictReport, CONFLICT_STATUSES, deployReport, fixPrMerge, grantFor, outOfAttempts } from './items.ts';
import type { Orchestrator } from './orchestrator.ts';
import { refOf } from './refs.ts';

/** Who is asking: the role of the sandbox the request came from, never what the request claims. */
export interface AgentIdentity {
  role: Role;
  sandbox: string;
  /** The Manager's or the Architect's module. */
  module?: string;
  /** The Manager's plan, when it manages one plan of the module (v3 §6.4). */
  plan?: string;
}

export interface Reply {
  ok: boolean;
  text: string;
}

interface Context {
  o: Orchestrator;
  agent: AgentIdentity;
  requestId: string;
}

type Handlers = { [T in ToolName]: (context: Context, args: ToolInput<T>) => Reply | undefined | Promise<Reply | undefined> };

const ok = (text: string): Reply => ({ ok: true, text });
const refuse = (text: string): Reply => ({ ok: false, text });

/**
 * The daemon's side of every harness tool (proposal v2 §9.3). The rules live here: which
 * role may call what, and in which state. Arguments are checked against the tool's
 * schema first, and a refusal says why, so the agent can correct itself. Every handler
 * can safely see the same request twice, as happens after a restart. `undefined` means
 * the reply comes later.
 */
export async function handleRequest(o: Orchestrator, agent: AgentIdentity, request: AgentRequest): Promise<Reply | undefined> {
  if (!TOOLS[agent.role].some((t) => t.name === request.tool)) return refuse(`${request.tool} is not one of your tools`);
  const name = request.tool as ToolName;
  const parsed = INPUTS[name].safeParse(request.args);
  if (!parsed.success) return refuse(`Invalid arguments:\n${z.prettifyError(parsed.error)}`);
  const handler = HANDLERS[name] as (context: Context, args: unknown) => Reply | undefined | Promise<Reply | undefined>;
  return handler({ o, agent, requestId: request.id }, parsed.data);
}

const HANDLERS: Handlers = {
  ask_manager({ o, agent, requestId }, { question }) {
    const active = attemptInSandbox(o.state, agent.sandbox);
    if (!active || active.attempt.status !== 'running') return refuse('Your attempt is no longer running.');
    const asked = active.attempt.questions?.find((q) => q.requestId === requestId);
    if (asked) return asked.answer === undefined ? undefined : ok(asked.answer);
    o.record({ type: 'QUESTION', ref: refOf(active.feature, active.attempt), from: 'developer', to: 'manager', payload: { requestId, question } });
    o.kick();
    return undefined;
  },

  async web_read({ o, agent }, { url }) {
    // Recorded however the read ends, a failure included. The URLs are clipped: every call
    // is a line of the event log, which the daemon reads whole when it starts.
    const recorded = 300;
    let result: Awaited<ReturnType<Orchestrator['webRead']>> | undefined;
    try {
      result = await o.webRead(url);
      return { ok: result.ok, text: result.text };
    } finally {
      o.record({
        type: 'WEB_READ',
        payload: {
          role: agent.role,
          sandbox: agent.sandbox,
          url: clip(url, recorded),
          finalUrl: result?.finalUrl === undefined ? undefined : clip(result.finalUrl, recorded),
          status: result?.status,
          bytes: result?.bytes ?? 0,
          ok: result?.ok ?? false,
        },
      });
    }
  },

  async answer_developer({ o, agent }, { question_id, answer }) {
    // Several attempts may run at once in Swarm (v3 §6.2): the question names its own.
    const active = activeAttempts(o.state).find((a) => inScope(agent, a.feature) && a.attempt.questions?.some((q) => q.requestId === question_id));
    const question = active?.attempt.questions?.find((q) => q.requestId === question_id);
    if (!active || !question) {
      return refuse(`No open question has the id ${question_id}. get_state lists the open questions.`);
    }
    if (question.answer !== undefined) return ok('That question is already answered.');
    if (active.attempt.status !== 'running') return refuse('The attempt that asked has ended, so your answer would reach nobody.');
    o.record({
      type: 'CONTINUE', ref: refOf(active.feature, active.attempt), from: 'manager', to: 'developer', payload: { requestId: question_id, answer },
    });
    const delivered = await o.replyToDeveloper(active.attempt.sandbox, question_id, answer);
    return ok(delivered ? 'The Developer has your answer.' : 'Recorded. The Developer gets it as soon as the daemon reaches its sandbox.');
  },

  accept_feature({ o, agent, requestId }, { feature, attempt, note }) {
    const found = underReview(o, agent, requestId, feature, attempt);
    if ('text' in found) return found;
    o.record({ type: 'ACCEPT', ref: refOf(found.state, found.attempt), from: 'manager', to: 'daemon', payload: { requestId, ...(note ? { note } : {}) } });
    o.kick();
    return ok(`Accepted. The daemon lands ${feature} on the plan branch as one commit.`);
  },

  reject_feature({ o, agent, requestId }, { feature, attempt, guidance }) {
    const found = underReview(o, agent, requestId, feature, attempt);
    if ('text' in found) return found;
    o.record({ type: 'REJECT', ref: refOf(found.state, found.attempt), from: 'manager', to: 'daemon', payload: { requestId, guidance } });
    o.kick();
    const left = attemptsLeft(o, found.state) - 1;
    return ok(left > 0
      ? `Rejected. The next attempt starts with your guidance (${left} left).`
      : 'Rejected. That was its last attempt, so the owner decides what happens next.');
  },

  retry_feature({ o, agent, requestId }, { feature, guidance }) {
    const state = o.state.features[feature];
    if (!state || !inScope(agent, state)) return refuse(`${feature} has no attempt in your ${scopeName(agent)}.`);
    const last = state.attempts.at(-1)!;
    if (state.status === 'escalated') {
      // Out of attempts: one more starts once the Architect decided on it, or the owner answered about it.
      if (!outOfAttempts(o, state)) return refuse(`${feature} is escalated: the owner decides now.`);
      const granted = grantFor(o, state);
      if (!granted) {
        return refuse(`${feature} used up its attempts: take it to the Architect with escalate_to_architect(feature: "${feature}", question). Another attempt starts once its decision has come, or the owner's answer to a question of yours.`);
      }
      o.record({ type: 'RETRY', ref: refOf(state, last), from: 'manager', to: 'daemon', payload: { requestId, guidance, granted } });
      o.kick();
      return ok(`One more attempt of ${feature} starts with your guidance.`);
    }
    if (!state.awaitingGuidanceSince) {
      return state.guidance !== undefined ? ok('The next attempt is already scheduled with guidance.') : refuse(`${feature} is not waiting for guidance (it is ${state.status}).`);
    }
    o.record({ type: 'RETRY', ref: refOf(state, last), from: 'manager', to: 'daemon', payload: { requestId, guidance } });
    o.kick();
    return ok(`The next attempt of ${feature} starts with your guidance.`);
  },

  abort_attempt({ o, agent, requestId }, { feature, attempt, reason }) {
    const active = activeAttempts(o.state).find((a) => featureKey(a.feature) === feature && a.attempt.n === attempt && inScope(agent, a.feature));
    if (!active) return refuse(`Attempt ${attempt} of ${feature} is not running.`);
    if (active.attempt.abort) return ok('It is already being stopped.');
    if (active.attempt.status !== 'running') return refuse(`Attempt ${attempt} of ${feature} is ${active.attempt.status}; only a running attempt can be stopped.`);
    o.record({ type: 'ABORT', ref: refOf(active.feature, active.attempt), from: 'manager', to: 'daemon', payload: { requestId, reason } });
    o.kick();
    return ok('The attempt is being stopped. It counts as failed; you will be asked for guidance for the next one.');
  },

  ask_owner({ o, agent, requestId }, { question, blocking }) {
    if (!o.state.ownerRequests[requestId]) {
      o.record({ type: 'OWNER_REQUEST', from: 'manager', to: 'owner', payload: { module: agent.module!, requestId, question, blocking, manager: managerKey({ module: agent.module!, plan: agent.plan }) } });
      o.kick();
    }
    return ok(`Asked the owner (request ${requestId}). The answer will arrive as a message.${blocking ? ' No new attempt starts until then.' : ''}`);
  },

  suggest_order({ o, agent, requestId }, { request_id, order, summary }) {
    const asked = o.state.order;
    if (!asked) return refuse('The owner asked for no order.');
    if (asked.requestId !== request_id) return refuse(`The owner asked again since: request ${asked.requestId} replaced ${request_id}. Answer that one once it reaches you.`);
    if (asked.manager !== managerKey({ module: agent.module!, plan: agent.plan })) return refuse('That request went to another Manager.');
    if (asked.suggestion) return asked.suggestion.call === requestId ? ok('Recorded.') : refuse('You already answered that request. The owner asks again if they want another order.');
    // Only the request's cards, each once; one left out goes last, without a reason.
    const known = new Set(asked.cards.map((card) => card.key));
    const placed = new Map<string, string>();
    for (const { card, why } of order) if (known.has(card) && !placed.has(card)) placed.set(card, why);
    const unknown = [...new Set(order.map(({ card }) => card).filter((card) => !known.has(card)))];
    if (placed.size === 0) return refuse(`None of these is a card of the request. Its cards: ${[...known].join(', ')}`);
    const missing = asked.cards.map((card) => card.key).filter((key) => !placed.has(key));
    o.record({
      type: 'ORDER_SUGGESTED',
      from: 'manager',
      to: 'owner',
      payload: {
        module: asked.module, requestId: request_id, call: requestId,
        order: [...[...placed].map(([key, why]) => ({ key, why })), ...missing.map((key) => ({ key, why: '' }))],
        ...(summary ? { summary } : {}),
      },
    });
    return ok([
      'The owner sees your order under Needs you. Nothing else changed.',
      ...(missing.length > 0 ? [`You left out ${missing.join(', ')}: shown last, without a reason.`] : []),
      ...(unknown.length > 0 ? [`Not cards of the request, and dropped: ${unknown.join(', ')}.`] : []),
    ].join(' '));
  },

  submit_plan({ o, agent, requestId }, { plan, summary }) {
    const state = o.state.plans[plan];
    if (!state || !inScope(agent, state)) return refuse(`${plan} is not ${agent.plan ? 'your plan' : 'a plan of your module'}.`);
    if (state.summary !== undefined) return ok(`${plan} is already submitted.`);
    if (state.status !== 'validating' || state.validation?.status !== 'passed') {
      return refuse(`${plan} is ${state.status}. Submit it once every feature is accepted and its full check run passed.`);
    }
    o.record({ type: 'PLAN_SUBMITTED', ref: { module: state.module, plan: state.plan }, from: 'manager', to: 'daemon', payload: { requestId, summary } });
    o.kick();
    return ok(`Submitted: ${plan} is complete.`);
  },

  get_state({ o, agent }) {
    const module = agent.module!;
    if (agent.role === 'architect') return ok(architectState(o, module));
    const plans = Object.values(o.state.plans).filter((p) => p.module === module).map((p) => ({
      plan: planKey(p),
      status: p.status,
      ...(p.validation ? { fullCheckRun: p.validation.status } : {}),
      ...(checksFail(p) ? { waitingFor: 'your fix of the checks that fail on its branch (request_fix)' } : {}),
      ...(p.mainConflict ? { conflictsWithMainIn: p.mainConflict.files } : {}),
      features: Object.values(o.state.features).filter((f) => f.module === module && f.plan === p.plan).map((f) => featureSummary(o, f)),
    }));
    const requests = Object.values(o.state.ownerRequests).filter((r) => r.module === module)
      .map((r) => ({ id: r.requestId, question: clip(r.question, 300), blocking: r.blocking, answer: r.answer ?? null }));
    return ok(JSON.stringify({ pipeline: o.state.pipeline.paused ? `paused: ${o.state.pipeline.paused.reason}` : 'running', plans, ownerRequests: requests }, null, 2));
  },

  get_ci_results({ o, agent }, { plan }) {
    const state = o.state.plans[plan];
    if (!state || !inScope(agent, state)) return refuse(`${plan} is not ${agent.plan ? 'your plan' : 'a plan of your module'}.`);
    return ok(ciReport(state));
  },

  async request_fix({ o, agent, requestId }, { plan, guidance }) {
    const state = o.state.plans[plan];
    if (!state || !inScope(agent, state)) return refuse(`${plan} is not ${agent.plan ? 'your plan' : 'a plan of your module'}.`);
    if (state.status === 'fixing') return ok(`A fix of ${plan} is already under way.`);
    // Main conflicts with the branch (v3 §6.6): a merge round, which comes before anything CI could say.
    if (state.mainConflict && CONFLICT_STATUSES.includes(state.status)) {
      o.record({
        type: 'REQUEST_FIX', ref: { module: state.module, plan: state.plan }, from: 'manager', to: 'daemon',
        payload: { requestId, guidance, failure: await conflictReport(o, state), merge: state.mainConflict },
      });
      o.kick();
      return ok(`Merge round ${state.mergeRounds} of ${plan} starts: a Developer merges main into the plan branch with your guidance, and you review the merge.`);
    }
    // Accepted work fails its checks on the branch: a round of its own, before the plan's build goes on.
    if (checksFail(state)) {
      o.record({
        type: 'REQUEST_FIX', ref: { module: state.module, plan: state.plan }, from: 'manager', to: 'daemon',
        payload: { requestId, guidance, failure: checksReport(state), checks: true },
      });
      o.kick();
      return ok(`Fix round ${state.checkRounds} of ${plan} starts on the plan branch: a Developer makes the checks of accepted work pass again with your diagnosis, and you review the fix.`);
    }
    if (state.status === 'deploy_failed' || state.status === 'verify_failed') {
      const limit = o.design.config.brakes.deployFixRounds;
      if ((state.deployFixRounds ?? 0) >= limit) return refuse(`${plan} used its ${limit} Fix PR(s): the owner decides now.`);
      o.record({ type: 'REQUEST_FIX', ref: { module: state.module, plan: state.plan }, from: 'manager', to: 'daemon', payload: { requestId, guidance, failure: deployReport(state) } });
      o.kick();
      return ok(`Fix PR round ${state.deployFixRounds} of ${plan} starts on ${state.branch}: a Developer fixes it, you review it, and its pull request goes through CI and ${fixPrMerge(o)}.`);
    }
    if (state.status !== 'pr_open' || state.ci?.status !== 'failed') {
      return refuse(`${plan} has no failed CI to fix: it is ${state.status}, CI ${state.ci?.status ?? 'not run yet'}.`);
    }
    const limit = o.design.config.brakes.ciFixRounds;
    if ((state.fixRounds ?? 0) >= limit) return refuse(`${plan} used its ${limit} fix round(s): the owner decides now.`);
    o.record({
      type: 'REQUEST_FIX', ref: { module: state.module, plan: state.plan }, from: 'manager', to: 'daemon',
      payload: { requestId, guidance, failure: ciReport(state) },
    });
    o.kick();
    return ok(`Fix round ${state.fixRounds} of ${plan} starts: a Developer fixes it on the plan branch with your diagnosis.`);
  },

  escalate_to_architect({ o, agent, requestId }, { question, feature }) {
    const module = o.state.modules[agent.module!];
    if (!module) return refuse(`${agent.module} has no Architect: its design was written by hand. Use ask_owner instead.`);
    if (!module.escalations.some((e) => e.id === requestId)) {
      o.record({
        type: 'ESCALATION', from: 'manager', to: 'architect',
        payload: { module: module.module, requestId, question, ...(feature ? { feature } : {}), manager: managerKey({ module: module.module, plan: agent.plan }) },
      });
      o.kick();
    }
    return ok(`Sent as escalation ${requestId}. The Architect is told at once; its decision comes to you as a message, which can take a while when the choice is the owner's.`);
  },

  async submit_proposal({ o, agent, requestId }, { version }) {
    const module = o.state.modules[agent.module!]!;
    if (module.proposals.some((p) => p.version === version)) return ok(`v${version} is already submitted.`);
    if (!['designing', 'proposed'].includes(module.status)) return refuse(`The owner accepted v${module.accepted}: decompose it, and change the design through submit_design.`);
    const next = module.proposals.length + 1;
    if (version !== next) return refuse(`The next proposal is v${next}.`);
    const path = `harness/modules/${module.module}/proposals/v${version}.md`;
    const read = await o.exec(module.architect.sandbox, `head -c 262144 ${sh(`${o.paths(module.architect.sandbox).work}/${path}`)}`);
    if (read.code !== 0 || read.stdout.trim() === '') return refuse(`Write ${path} first.`);
    const dir = join(o.moduleDir(module.module), 'proposals');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `v${version}.md`), read.stdout);
    o.record({ type: 'PROPOSAL', from: 'architect', to: 'owner', payload: { module: module.module, requestId, version, sha256: sha256(read.stdout) } });
    o.kick();
    return ok(`Proposal v${version} is in the dashboard. The owner accepts it there, or tells you what to change.`);
  },

  async submit_design({ o, agent, requestId }, { summary }) {
    const module = o.state.modules[agent.module!]!;
    if (module.submission) return module.submission.requestId === requestId ? undefined : refuse('A design is already being checked. Wait for its answer.');
    if (['designing', 'proposed'].includes(module.status)) return refuse('No proposal is accepted yet. The owner accepts one in the dashboard first.');
    if (o.forge.kind !== 'github') return refuse('This project has no GitHub repository (project.repo), and designs land through Arch PRs.');
    const taken = await o.architects.takeDesign(module);
    if (!taken.head) return refuse(`Not submitted: ${taken.problem}.`);
    o.record({ type: 'DESIGN', from: 'architect', to: 'daemon', payload: { module: module.module, requestId, summary, head: taken.head } });
    o.kick();
    return undefined;
  },

  async submit_locked_change({ o, agent, requestId }, { summary }) {
    const module = o.state.modules[agent.module!]!;
    if (module.lockedSubmission) return module.lockedSubmission.requestId === requestId ? undefined : refuse('A change to locked files is already being checked. Wait for its answer.');
    if (!module.frozenCommit) return refuse('Nothing is locked yet: the owner merges your first design before any feature is built.');
    if (o.forge.kind !== 'github') return refuse('This project has no GitHub repository (project.repo), and locked changes land through PRs.');
    const taken = await o.architects.takeDesign(module, 'locked');
    if (!taken.head) return refuse(`Not submitted: ${taken.problem}.`);
    o.record({ type: 'LOCKED_CHANGE', from: 'architect', to: 'daemon', payload: { module: module.module, requestId, summary, head: taken.head } });
    o.kick();
    return undefined;
  },

  get_inbox({ o, agent }) {
    const module = o.state.modules[agent.module!]!;
    if (module.notes.length === 0) return ok('No messages.');
    return ok(module.notes.slice(-20).map((n) => n.text).join('\n\n---\n\n'));
  },

  async get_owner_time({ o, agent }) {
    return ok(describeOwnerTime(await o.ownerTime(), agent.module!));
  },

  reply_to_manager({ o, agent, requestId }, { escalation_id, decision }) {
    const module = o.state.modules[agent.module!]!;
    const escalation = module.escalations.find((e) => e.id === escalation_id);
    if (!escalation) return refuse(`No escalation has the id ${escalation_id}. get_state lists them.`);
    if (escalation.decision !== undefined) return ok('That escalation is already answered.');
    o.record({ type: 'DECISION', from: 'architect', to: 'manager', payload: { module: module.module, requestId, escalationId: escalation_id, decision } });
    o.kick();
    return ok('The Manager has your decision.');
  },

  get_attempt({ o, agent }, { feature, attempt: n }) {
    const state = o.state.features[feature];
    const attempt = state?.attempts.find((a) => a.n === n);
    if (!state || !attempt || !inScope(agent, state)) return refuse(`${feature} has no attempt ${n} in your ${scopeName(agent)}.`);
    const taskFile = join(o.attemptDir(refOf(state, attempt)), 'task.md');
    const task = existsSync(taskFile) ? readFileSync(taskFile, 'utf8') : '(no task was written)';
    return ok([
      `# ${feature} attempt ${n}: ${attempt.status}${attempt.reason ? ` (${attempt.reason})` : ''}`,
      '',
      `Outcome: ${attempt.outcome ?? 'none yet'}. Report: ${attempt.summary ?? 'none'}`,
      ...(attempt.notes ? [`Notes: ${attempt.notes}`] : []),
      ...(attempt.finding ? [`Finding (${attempt.finding.category}): ${attempt.finding.summary}. Needs: ${attempt.finding.needs ?? '-'}`] : []),
      ...(attempt.decision ? [`Decision: ${attempt.decision.kind}${attempt.decision.text ? `: ${attempt.decision.text}` : ''}`] : []),
      ...(attempt.questions ?? []).map((q) => `Question: ${q.text}\nAnswer: ${q.answer ?? '(none)'}`),
      '',
      '## Checks',
      ...(attempt.checks ?? []).map((c) => `- ${c.id}: exit ${c.exit}${c.exit === 0 ? '' : `\n${tail(c.output.trim(), 1500)}`}`),
      '',
      '## The task it was given',
      '',
      task,
    ].join('\n'));
  },
};

/** The attempt the Manager names, if it is waiting for exactly this review. */
function underReview(o: Orchestrator, agent: AgentIdentity, requestId: string, feature: string, n: number): { state: FeatureState; attempt: Attempt } | Reply {
  const state = o.state.features[feature];
  const attempt = state?.attempts.find((a) => a.n === n);
  if (!state || !attempt || !inScope(agent, state)) return refuse(`${feature} has no attempt ${n} in your ${scopeName(agent)}.`);
  if (attempt.decision?.requestId === requestId) return ok('Recorded.');
  if (attempt.decision) return refuse(`Attempt ${n} of ${feature} was already ${attempt.decision.kind === 'accept' ? 'accepted' : 'rejected'}.`);
  if (attempt.status !== 'reviewing') {
    const why = attempt.status === 'checking' ? ': its checks are still running' : '';
    return refuse(`Attempt ${n} of ${feature} is ${attempt.status}, not waiting for a review${why}.`);
  }
  return { state, attempt };
}

function featureSummary(o: Orchestrator, feature: FeatureState) {
  const waitingFor = feature.awaitingGuidanceSince
    ? 'your guidance (retry_feature)'
    : !outOfAttempts(o, feature) ? undefined
      : grantFor(o, feature) ? 'retry_feature, if the decision you got grants another attempt; a design change otherwise'
        : "the Architect's decision on it (escalate_to_architect, if you haven't yet)";
  return {
    feature: featureKey(feature),
    status: feature.status,
    ...(waitingFor ? { waitingFor } : {}),
    ...(feature.escalation ? { escalation: feature.escalation } : {}),
    attempts: feature.attempts.map((a) => ({
      n: a.n,
      status: a.status,
      ...(a.outcome ? { outcome: a.outcome } : {}),
      ...(a.reason ? { reason: clip(a.reason, 300) } : {}),
      ...(a.questions?.length ? { questions: a.questions.map((q) => ({ id: q.requestId, question: clip(q.text, 200), answered: q.answer !== undefined })) } : {}),
    })),
  };
}

/** A Manager acts within its scope: its module, or in Swarm its one plan of it (v3 §6.4). */
const inScope = (agent: AgentIdentity, of: { module: string; plan: string }) =>
  agent.role === 'developer' || (agent.module === of.module && (agent.plan === undefined || agent.plan === of.plan));
const scopeName = (agent: AgentIdentity) => (agent.plan ? 'plan' : 'module');

/** The Architect's view: its module's design and how the build of it goes. */
function architectState(o: Orchestrator, id: string): string {
  const module = o.state.modules[id]!;
  const plans = Object.values(o.state.plans).filter((p) => p.module === id).map((p) => ({
    plan: planKey(p),
    status: p.status,
    // Past its build, a plan's features are locked: submit_locked_change, or a new plan that supersedes them (v5).
    locked: isBuilt(o, id, p.plan),
    features: Object.values(o.state.features).filter((f) => f.module === id && f.plan === p.plan).map((f) => ({
      feature: f.feature, status: f.status, attempts: f.attempts.length, ...(f.escalation ? { escalation: f.escalation } : {}),
    })),
  }));
  return JSON.stringify({
    module: id,
    status: module.status,
    proposals: module.proposals.map((p) => `v${p.version}${p.acceptedAt ? ' (accepted)' : ''}`),
    ...(module.design ? { designUnderReview: { pr: module.design.pr?.url, suspectChecks: module.design.suspect } } : {}),
    ...(module.locked ? { lockedChangeUnderReview: { pr: module.locked.pr?.url, features: module.locked.changes.map((c) => `${c.plan}/${c.feature}`) } } : {}),
    plans,
    openEscalations: module.escalations.filter((e) => e.decision === undefined).map((e) => ({ id: e.id, question: clip(e.question, 400), feature: e.feature })),
  }, null, 2);
}
