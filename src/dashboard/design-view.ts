import { planDependencies, type Design } from '../design/schemas.ts';

/**
 * The design on main as the dashboard's pages get it: what they show of the configuration,
 * and each module's plans, features and owner actions. The daemon reads the cards of Needs
 * you from the same view, for the order it asks a Manager for.
 */
export function designView({ config, modules }: Design) {
  return {
    project: config.project.name,
    repo: config.project.repo,
    maxAttempts: config.roles.developer.maxAttempts,
    attemptMinutes: config.roles.developer.attemptTimeoutMinutes,
    // Each role's model and effort, for the active hours by agent; the reviewers run on the Manager's.
    roles: Object.fromEntries((['architect', 'manager', 'developer'] as const).map((role) => [role, { model: config.roles[role].model, effort: config.roles[role].effort }])) as Record<'architect' | 'manager' | 'developer', { model: string; effort: string | null }>,
    terraform: config.terraform !== undefined,
    ownerTime: config.ownerTime,
    swarm: config.swarm,
    modules: modules.map((m) => ({
      id: m.id,
      plans: m.plans.map((p) => ({
        // What the plan waits for, and each feature's dependencies, for the graph (v3 §6.7).
        dependsOn: planDependencies(m, p),
        id: p.id,
        title: p.title,
        goal: p.goal,
        features: p.features.map((f) => ({ id: f.id, title: f.title, kind: f.kind, dependsOn: f.dependsOn, supersedes: f.supersedes, gates: f.gates, checks: f.checks.map((c) => ({ id: c.id, phase: c.phase, needs: c.needs })) })),
      })),
      actions: m.actions.map((a) => ({
        id: a.id, kind: a.kind, title: a.title, when: a.when, blocks: a.blocks, instructions: a.instructions, verify: a.verify !== null, estimatedMinutes: a.estimatedMinutes,
      })),
    })),
  };
}

export type DesignView = ReturnType<typeof designView>;
