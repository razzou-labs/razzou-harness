import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { featureDependency, planDependencies, PlanSchema } from '../src/design/schemas.ts';

const feature = (id: string, dependsOn: string[] = []) => ({
  id, title: id, description: 'd', expected: 'e', dependsOn, checks: [{ id: `${id}-c`, run: 'true', phase: 'pre-merge' }],
});
const plan = (id: string, extra: Record<string, unknown> = {}) => ({ id, module: 'm', title: id, goal: 'g', features: [feature('F01'), feature('F02', ['F01'])], ...extra });

describe('plan dependencies (v3 §6.1)', () => {
  it('fall back to the previous plan, so that nothing runs in parallel unless the Architect says so', () => {
    const module = { plans: [PlanSchema.parse(plan('P1')), PlanSchema.parse(plan('P2')), PlanSchema.parse(plan('P3', { dependsOn: [] })), PlanSchema.parse(plan('P4', { dependsOn: ['P1'] }))] };
    assert.deepEqual(module.plans.map((p) => planDependencies(module, p)), [[], ['P1'], [], ['P1']]);
  });

  it('refuse a plan that depends on itself, and a feature that depends on a later one of its plan', () => {
    assert.match(PlanSchema.safeParse(plan('P1', { dependsOn: ['P1'] })).error?.message ?? '', /P1 depends on itself/);
    const later = plan('P1', { features: [feature('F01', ['F02']), feature('F02')] });
    assert.match(PlanSchema.safeParse(later).error?.message ?? '', /F01 depends on F02, which is not an earlier feature of this plan/);
  });

  it('read a dependency on an earlier plan\'s feature as plan/feature', () => {
    assert.deepEqual(featureDependency('P2', 'F01'), { plan: 'P2', feature: 'F01' });
    assert.deepEqual(featureDependency('P2', 'P1/F03'), { plan: 'P1', feature: 'F03' });
    assert.equal(PlanSchema.safeParse(plan('P2', { features: [feature('F01', ['P1/F03'])] })).success, true);
    assert.equal(PlanSchema.safeParse(plan('P2', { features: [feature('F01', ['P1/F03/x'])] })).success, false);
  });
});
