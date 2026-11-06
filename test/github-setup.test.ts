import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { BranchRules } from '../src/github/forge.ts';
import { mainRuleset, rulesProblems } from '../src/github/setup.ts';

interface Ruleset {
  name: string;
  enforcement: string;
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
}

const GITHUB_ACTIONS = 15368;
const rule = (ruleset: object, type: string) => (ruleset as Ruleset).rules.find((r) => r.type === type)?.parameters ?? {};
const required = (ruleset: object) => rule(ruleset, 'required_status_checks').required_status_checks as Array<{ context: string; integration_id?: number }>;

describe('the ruleset on main', () => {
  it('in Manual needs one approval from a code owner, and the CI jobs from GitHub Actions', () => {
    const ruleset = mainRuleset(['verify', 'checks']);
    assert.equal((ruleset as Ruleset).name, 'harness: main');
    assert.equal((ruleset as Ruleset).enforcement, 'active');
    const pr = rule(ruleset, 'pull_request');
    assert.equal(pr.required_approving_review_count, 1);
    assert.equal(pr.require_code_owner_review, true);
    assert.deepEqual(pr.allowed_merge_methods, ['merge']);
    assert.deepEqual(required(ruleset), [
      { context: 'verify', integration_id: GITHUB_ACTIONS },
      { context: 'checks', integration_id: GITHUB_ACTIONS },
    ]);
    assert.deepEqual(mainRuleset(['verify', 'checks'], { mode: 'manual' }), ruleset);
    assert.ok((ruleset as Ruleset).rules.some((r) => r.type === 'deletion'));
    assert.ok((ruleset as Ruleset).rules.some((r) => r.type === 'non_fast_forward'));
  });

  it("in Swarm needs no approval, and the reviewers' statuses from the App", () => {
    const ruleset = mainRuleset(['verify', 'checks', 'tf-plan'], { mode: 'swarm', appId: 4242, statuses: ['harness/security', 'harness/cost'] });
    const pr = rule(ruleset, 'pull_request');
    assert.equal(pr.required_approving_review_count, 0);
    assert.equal(pr.require_code_owner_review, false);
    assert.deepEqual(pr.allowed_merge_methods, ['merge']);
    assert.deepEqual(required(ruleset), [
      { context: 'verify', integration_id: GITHUB_ACTIONS },
      { context: 'checks', integration_id: GITHUB_ACTIONS },
      { context: 'tf-plan', integration_id: GITHUB_ACTIONS },
      { context: 'harness/security', integration_id: 4242 },
      { context: 'harness/cost', integration_id: 4242 },
    ]);
    // A PR is still required, and the owner still bypasses.
    assert.ok((ruleset as Ruleset).rules.some((r) => r.type === 'pull_request'));
    assert.deepEqual((ruleset as { bypass_actors: unknown[] }).bypass_actors, [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]);
  });

  it('in Swarm merges on CI alone when no status is configured', () => {
    const ruleset = mainRuleset(['verify', 'checks'], { mode: 'swarm', appId: 4242, statuses: [] });
    assert.equal(rule(ruleset, 'pull_request').required_approving_review_count, 0);
    assert.deepEqual(required(ruleset).map((c) => c.context), ['verify', 'checks']);
  });

  it("in Swarm refuses to pin statuses without the App's id", () => {
    assert.throws(() => mainRuleset(['verify'], { mode: 'swarm', statuses: ['harness/security'] }), /github-app create/);
  });

  it('in Manual ignores statuses and the App id', () => {
    const ruleset = mainRuleset(['verify'], { mode: 'manual', appId: 4242, statuses: ['harness/security'] });
    assert.deepEqual(required(ruleset).map((c) => c.context), ['verify']);
    assert.equal(rule(ruleset, 'pull_request').required_approving_review_count, 1);
  });
});

describe("the rules in effect on main, read through the App (v4 §6)", () => {
  const jobs = [{ context: 'verify', integrationId: 15368 }, { context: 'checks', integrationId: 15368 }];
  const manual: BranchRules = { approvals: 1, codeOwners: true, checks: jobs };
  const swarm: BranchRules = { approvals: 0, codeOwners: false, checks: [...jobs, { context: 'harness/security', integrationId: 4242 }, { context: 'harness/cost', integrationId: 4242 }] };
  const options = (mode: 'manual' | 'swarm') => ({ mode, requiredChecks: ['verify', 'checks'], statuses: mode === 'swarm' ? ['harness/security', 'harness/cost'] : [], appId: 4242 });

  it('match the mode they were set for, and say what the other mode lacks', () => {
    assert.deepEqual(rulesProblems(manual, options('manual')), []);
    assert.deepEqual(rulesProblems(swarm, options('swarm')), []);
    assert.deepEqual(rulesProblems(manual, options('swarm')), [
      "1 approval is required, which the daemon can't give",
      "the harness/security status isn't required",
      "the harness/cost status isn't required",
    ]);
    assert.deepEqual(rulesProblems(swarm, options('manual')), ["a code owner's approval isn't required"]);
  });

  it('name a missing job, a status pinned elsewhere, and rules that cannot be read', () => {
    assert.deepEqual(rulesProblems({ ...manual, checks: [jobs[0]!] }, options('manual')), ["the checks job isn't required"]);
    const elsewhere = { ...swarm, checks: swarm.checks.map((c) => (c.context === 'harness/cost' ? { context: c.context, integrationId: 1 } : c)) };
    assert.deepEqual(rulesProblems(elsewhere, options('swarm')), ["the harness/cost status isn't pinned to the App"]);
    assert.deepEqual(rulesProblems(undefined, options('swarm')), ["main's rules can't be read through the App: check them with `harness doctor`"]);
    assert.deepEqual(rulesProblems({ approvals: 0, codeOwners: false, checks: [] }, options('manual')), ["the verify job isn't required", "the checks job isn't required", "a code owner's approval isn't required"]);
  });
});
