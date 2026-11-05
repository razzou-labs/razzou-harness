import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mainRuleset } from '../src/github/setup.ts';

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
