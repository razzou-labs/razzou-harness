import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Repo } from '../git/repo.ts';
import { ALL_BUNDLES, BUNDLES } from '../sandbox/allowlist.ts';
import { canonicalJson, sha256 } from '../util.ts';

/** The agents' image is tagged with the harness's version, which may change what goes into it: `harness doctor --build-images` builds it. */
const AGENT_IMAGE = `razzou-harness/agent:${(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version}`;

/** Ids end up in branch names, refs and sandbox names, so they stay short and plain. */
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/, 'use letters, digits and dashes (at most 40)');
/** A feature of the same plan, or `P1/F03`: a feature of an earlier plan of the module (v3 §6.1). */
const FeatureRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,39}(\/[A-Za-z0-9][A-Za-z0-9-]{0,39})?$/, 'a feature id, or plan/feature for a feature of an earlier plan');

export const CheckSchema = z.object({
  id: Id,
  run: z.string().min(1),
  phase: z.enum(['pre-merge', 'post-deploy']),
  timeoutSec: z.number().int().positive().max(7200).default(600),
  needs: z.array(z.enum(['aws', 'tfplan'])).default([]),
});
export type Check = z.infer<typeof CheckSchema>;

export const FeatureSchema = z.object({
  id: Id,
  title: z.string().min(1),
  kind: z.enum(['app', 'infra']).default('app'),
  description: z.string().min(1),
  expected: z.string().min(1),
  dependsOn: z.array(FeatureRef).default([]),
  /**
   * Built features of earlier plans whose behavior this one changes, as `P2/F04`: from the
   * moment this feature is accepted, their checks no longer run. Their definitions stay as
   * the record of what was built; this feature's checks prove what is true now.
   */
  supersedes: z.array(FeatureRef).default([]),
  gates: z.array(z.string()).default([]),
  resources: z.array(z.string()).default([]),
  checks: z.array(CheckSchema).min(1),
});
export type Feature = z.infer<typeof FeatureSchema>;

export const PlanSchema = z
  .object({
    id: Id,
    module: Id,
    title: z.string().min(1),
    goal: z.string().min(1),
    /**
     * The plans of the module that must be merged before this one starts (v3 §6.1).
     * Absent, the previous plan in order, as in v2; empty, none: in Swarm it builds
     * alongside the others.
     */
    dependsOn: z.array(Id).optional(),
    features: z.array(FeatureSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    if (plan.dependsOn?.includes(plan.id)) ctx.addIssue({ code: 'custom', message: `${plan.id} depends on itself` });
    const seen = new Set<string>();
    for (const feature of plan.features) {
      if (seen.has(feature.id)) ctx.addIssue({ code: 'custom', message: `feature ${feature.id} appears twice` });
      // A dependency on another plan's feature is checked against the module (checkReferences).
      for (const dep of feature.dependsOn.filter((d) => !d.includes('/'))) {
        if (!seen.has(dep)) ctx.addIssue({ code: 'custom', message: `${feature.id} depends on ${dep}, which is not an earlier feature of this plan` });
      }
      seen.add(feature.id);
    }
  });
export type Plan = z.infer<typeof PlanSchema>;

/**
 * A plan's kind follows from its features' (v3 §3.1): it is tagged in the PR's title, and
 * CI keeps a CODE PR off the Terraform folder. Infrastructure gets plans of its own.
 */
export type PlanKind = 'CODE' | 'INFRA' | 'MIXED';
export function planKind(plan: Pick<Plan, 'features'>): PlanKind {
  const infra = plan.features.filter((f) => f.kind === 'infra').length;
  return infra === 0 ? 'CODE' : infra === plan.features.length ? 'INFRA' : 'MIXED';
}

/** A plan kind as the owner reads it, in titles and messages: MIXED says what it mixes. */
export const KIND_TAGS: Record<PlanKind, string> = { CODE: 'CODE', INFRA: 'INFRA', MIXED: 'MIXED_INFRA_AND_CODE' };

/** The plans a plan waits for (v3 §6.1): what it declares, or else the previous plan of its module, which keeps v2's order. */
export function planDependencies(module: Pick<ModuleDesign, 'plans'>, plan: Pick<Plan, 'id' | 'dependsOn'>): string[] {
  if (plan.dependsOn) return plan.dependsOn;
  const i = module.plans.findIndex((p) => p.id === plan.id);
  const previous = i > 0 ? module.plans[i - 1] : undefined;
  return previous ? [previous.id] : [];
}

/** What a feature's dependency names: a feature of its own plan, or of an earlier one as `P1/F03`. */
export function featureDependency(planId: string, dep: string): { plan: string; feature: string } {
  const [a, b] = dep.split('/') as [string, string | undefined];
  return b === undefined ? { plan: planId, feature: a } : { plan: a, feature: b };
}

/** Variables the harness, OpenShell or the system set in a sandbox: an API's key can't take one of their names. */
const RESERVED_VARIABLES = /^(AWS_|CLAUDE_|OPENSHELL_|HARNESS_|SSL_|NODE_|NPM_)|^(PATH|HOME|USER|SHELL|LANG|TERM|PWD|TMPDIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|DISABLE_AUTOUPDATER|CHECKPOINT_DISABLE|MCP_TOOL_TIMEOUT)$/;

/** A third-party API of `network.apis`: an exact host, and the variable its key is read from, if it has one. */
const ApiSchema = z.object({
  host: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'a host name, like api.stripe.com'),
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'a variable name in capitals, like STRIPE_API_KEY')
    .refine((name) => !RESERVED_VARIABLES.test(name), 'a variable the harness, OpenShell or the system sets; pick another name, like STRIPE_API_KEY').optional(),
}).strict();

export const ConfigSchema = z.object({
  harnessVersion: z.string(),
  project: z.object({
    name: Id,
    /** The GitHub repository, like "acme/shop". Without it, the harness works locally and opens no pull requests. */
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name').optional(),
    /** The harness App's bot login, like "acme-harness[bot]": CI tells its PRs from the owner's by it. */
    bot: z.string().regex(/^[\w.-]+\[bot\]$/, 'an App bot login, like "acme-harness[bot]"').optional(),
  }).refine((p) => (p.repo === undefined) === (p.bot === undefined), 'set project.repo and project.bot together'),
  roles: z
    .object({
      developer: z
        .object({
          agent: z.enum(['claude-code']).default('claude-code'),
          model: z.string().default('claude-opus-5-5'),
          /** Claude Code's `--effort`; `null` leaves it to Claude Code, for models without effort levels. */
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default('max'),
          attemptTimeoutMinutes: z.number().int().positive().max(600).default(180),
          maxAttempts: z.number().int().min(1).max(5).default(2),
        })
        .prefault({}),
      // The reviewers run on the Manager's model and effort.
      manager: z
        .object({
          agent: z.enum(['claude-code']).default('claude-code'),
          model: z.string().default('claude-opus-5-5'),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default('max'),
        })
        .prefault({}),
      // The most capable model designs: a better design saves Developers' attempts.
      architect: z
        .object({
          agent: z.enum(['claude-code']).default('claude-code'),
          model: z.string().default('claude-fable-5-2'),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default('max'),
        })
        .prefault({}),
    })
    .prefault({}),
  sandbox: z
    .object({
      image: z.string().default(AGENT_IMAGE),
      claudeProvider: z.string().default('claude-sub'),
      env: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
  network: z
    .object({
      /** The hosts sandboxes reach directly, read-only, by bundle; `all`, the default, is every bundle. */
      bundles: z.array(z.string().refine((name) => name === ALL_BUNDLES || name in BUNDLES, `a bundle: ${ALL_BUNDLES}, ${Object.keys(BUNDLES).join(', ')}`)).default([ALL_BUNDLES]),
      extraHosts: z.array(z.string()).default([]),
      /**
       * Third-party APIs sandboxes may call with any method, like a payment provider's test
       * API. `key` names the variable the project's code reads the API's key from: in a
       * sandbox it holds a placeholder, which OpenShell replaces with the key on requests to
       * the host alone. `harness doctor` stores the key, at a hidden prompt.
       */
      apis: z.array(ApiSchema).default([])
        .refine((apis) => new Set(apis.map((a) => a.host)).size === apis.length, 'each host once')
        .refine((apis) => { const keys = apis.flatMap((a) => (a.key ? [a.key] : [])); return new Set(keys).size === keys.length; }, 'each key once'),
    })
    .prefault({}),
  checks: z.array(CheckSchema).default([]),
  /** More protected tool configs: whole files, and JSON fields by file (§8.7). */
  protect: z
    .object({
      files: z.array(z.string()).default([]),
      jsonFields: z.record(z.string(), z.array(z.string().startsWith('/'))).default({}),
    })
    .prefault({}),
  github: z
    .object({
      /** The CI jobs a plan's pull request must pass. */
      requiredChecks: z.array(z.string()).min(1).default(['verify', 'checks']),
      /** The job that applies Terraform on main after a merge. */
      applyJob: z.string().default('tf-apply'),
    })
    .prefault({}),
  /**
   * AWS, seen through the project's view-only role (§12). The role lives in an OpenShell
   * provider, which signs the agents' requests: no sandbox ever holds its credentials.
   */
  aws: z
    .object({
      region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'an AWS region, like us-east-1'),
      /** The OpenShell provider holding the view role, like "aws-view-shop". */
      provider: z.string().min(1),
      /** The services whose endpoints are reachable, and signed; `all`, the default, is every one, so the view role alone decides. */
      services: z.array(z.string().regex(/^[a-z0-9-]+$/)).default(['all']),
    })
    .optional(),
  /** Where the project's Terraform lives, and how a plan is made against the real state (§12.4). */
  terraform: z
    .object({
      /**
       * The folder `iac`, written `iac`, `./iac` or `iac/` alike, with its backend config and
       * variables file: the three paths the CI workflow plans and applies with. They are
       * settings only in name: another value would be planned in the sandboxes and never
       * applied, while the daemon recorded a deploy.
       */
      dir: z.string().transform((dir) => dir.replace(/^(?:\.?\/)+/, '').replace(/\/+$/, ''))
        .refine((dir) => dir === 'iac', 'the CI workflow plans and applies the folder iac/: keep "iac"').default('iac'),
      backendConfig: z.string().refine((path) => path === 'backend-configs/staging.hcl', 'the CI workflow uses backend-configs/staging.hcl: keep it').default('backend-configs/staging.hcl'),
      varFile: z.string().refine((path) => path === 'env/staging.tfvars', 'the CI workflow uses env/staging.tfvars: keep it').default('env/staging.tfvars'),
    })
    .optional(),
  brakes: z
    .object({
      consecutiveFailures: z.number().int().min(1).default(3),
      /** How long an item may wait for the Manager before a reminder; as long again, and the pipeline pauses. */
      managerTurnMinutes: z.number().int().min(1).max(240).default(90),
      /** Fix rounds for a pull request whose CI fails, before the owner decides. */
      ciFixRounds: z.number().int().min(0).max(5).default(2),
      /** Fix PRs after a failed apply or failed post-deploy checks, before the owner decides. */
      deployFixRounds: z.number().int().min(0).max(5).default(2),
    })
    .prefault({}),
  /** The owner's time as a design constraint (v3 §4.1), once the owner sets their hours in the dashboard: only owner actions count. */
  ownerTime: z
    .object({
      /** The share of the owner's hours that designs may not plan: escalations, questions and merges come out of it. */
      reservePercent: z.number().int().min(0).max(90).default(20),
    })
    .prefault({}),
  /** Swarm mode (v3): what the daemon may merge, how many agents run at once, and the subscription's ceiling. */
  swarm: z
    .object({
      maxDevelopers: z.number().int().min(1).max(10).default(3),
      maxPlans: z.number().int().min(1).max(5).default(2),
      merge: z
        .object({
          /** Who merges a CODE plan's PR once CI and the reviewers pass. */
          code: z.enum(['daemon', 'owner']).default('daemon'),
          /** The monthly cost an INFRA or MIXED PR may add and still merge itself; null leaves them all to the owner. */
          infraMonthlyUsdCeiling: z.number().min(0).nullable().default(50),
        })
        .prefault({}),
      /** The App's commit statuses a PR needs before the daemon merges it; [] merges on CI alone. */
      requiredStatuses: z.array(z.string().min(1)).default(['harness/security', 'harness/cost']),
      /** No attempt starts at or above this share of the subscription's limits; null turns the probe off. */
      usageCeilingPercent: z.number().int().min(1).max(100).nullable().default(80),
      securityFixRounds: z.number().int().min(0).max(5).default(2),
      costFixRounds: z.number().int().min(0).max(5).default(2),
      /** A reviewer's clock: it reads one diff, so it is short. */
      reviewTimeoutMinutes: z.number().int().positive().max(240).default(30),
      /** Run the reviewers in Manual mode too, as comments only. */
      reviewersInManual: z.boolean().default(false),
    })
    .prefault({}),
  dashboard: z.object({ port: z.number().int().min(1024).max(65535).default(4777) }).prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

/**
 * The CI jobs a pull request must pass, with `tf-plan` when the project has Terraform
 * (§11.5). A failed plan skips `checks`, and GitHub counts a skipped job as passed.
 */
export function requiredChecks(config: Pick<Config, 'github' | 'terraform'>): string[] {
  const listed = config.github.requiredChecks;
  return config.terraform && !listed.includes('tf-plan') ? [...listed, 'tf-plan'] : listed;
}

/** What a Developer returns as its structured output (`--json-schema`). */
export const ReportSchema = z.object({
  outcome: z.enum(['done', 'blocked']),
  summary: z.string().min(1).max(2000),
  finding: z
    .object({
      category: z.enum(['missing_decision', 'spec_gap', 'environment', 'dependency', 'check_defect', 'external', 'implementation']),
      summary: z.string().min(1),
      tried: z.array(z.string()).default([]),
      needs: z.string().min(1),
    })
    .optional(),
  notes: z.string().max(4000).optional(),
});
export type Report = z.infer<typeof ReportSchema>;

/** The two reviewers of v3 §5, which post `harness/security` and `harness/cost`. */
export type ReviewerRole = 'security' | 'cost';
export const REVIEWER_ROLES: readonly ReviewerRole[] = ['security', 'cost'];
export const statusContext = (role: ReviewerRole): string => `harness/${role}`;

/** What a reviewer returns as its structured output (v3 §5.4): a verdict, and findings with a place in the diff when there is one. */
export const ReviewReportSchema = z.object({
  verdict: z.enum(['pass', 'block']),
  summary: z.string().min(1).max(2000),
  findings: z.array(z.object({
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
    severity: z.enum(['blocking', 'advisory']),
    title: z.string().min(1).max(200),
    detail: z.string().min(1).max(4000),
  })).max(50).default([]),
});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
export type ReviewFinding = ReviewReport['findings'][number];

/** Something only the owner can do (§8.4). A gate holds back what it blocks until the owner marks it done; a task holds nothing back. */
export const OwnerActionSchema = z.object({
  id: Id,
  kind: z.enum(['gate', 'task']),
  title: z.string().min(1),
  when: z.string().default('anytime'),
  /** Plans ("P2") or features ("P2/F08") of the same module. */
  blocks: z.array(z.string().regex(/^[A-Za-z0-9-]+(\/[A-Za-z0-9-]+)?$/, 'a plan like "P2", or a feature like "P2/F08"')).default([]),
  /** Markdown, shown to the owner as text. */
  instructions: z.string().min(1),
  /** How long the action takes the owner. Required once the owner budgets their time (v3 §4.1). */
  estimatedMinutes: z.number().int().positive().optional(),
  /** Run in a check sandbox before the action counts as done. */
  verify: z
    .object({ run: z.string().min(1), timeoutSec: z.number().int().positive().max(3600).default(300), needs: z.array(z.enum(['aws', 'tfplan'])).default([]) })
    .nullable()
    .default(null),
});
export type OwnerAction = z.infer<typeof OwnerActionSchema>;

export interface ModuleDesign {
  id: string;
  plans: Plan[];
  actions: OwnerAction[];
}

export interface Design {
  config: Config;
  modules: ModuleDesign[];
}

/** The design files a check runs, named in its command. */
export function checkScripts(check: Check): string[] {
  return check.run.match(/harness\/modules\/[^\s'"`;|&)]+/g) ?? [];
}

/** The blob ids of the design files each loaded feature's checks run. */
const scripts = new WeakMap<Feature, Record<string, string>>();

/** The design files a loaded feature's checks run, each with its blob id: which of them a change touched. */
export function scriptsOf(feature: Feature): Record<string, string> {
  return scripts.get(feature) ?? {};
}

/**
 * The hash of a feature's definition: its JSON, and the design files its checks run. A
 * changed definition, a fixed check script among them, starts a fresh attempt budget.
 */
export function definitionHash(feature: Feature): string {
  const files = scripts.get(feature);
  // Without a `supersedes`, the hash is the one from before the field existed: no feature is redefined by an upgrade.
  const { supersedes, ...rest } = feature;
  const defined = supersedes.length > 0 ? feature : rest;
  return sha256(canonicalJson(files ? { feature: defined, files } : defined));
}

/**
 * The hash of a plan's checks of one phase as a design defines them: the entries, and the
 * design files they run. A change, by whoever, is one this hash shows.
 */
export function checksHash(plan: Plan, phase: Check['phase']): string {
  return sha256(canonicalJson(plan.features.map((feature) => {
    const checks = feature.checks.filter((c) => c.phase === phase);
    const files = scripts.get(feature) ?? {};
    const runs = new Set(checks.flatMap(checkScripts));
    return { id: feature.id, checks, files: Object.fromEntries(Object.entries(files).filter(([path]) => runs.has(path))) };
  })));
}

/** Reads config and plans from a commit, never from a working tree: the daemon acts on what is committed. */
export async function loadDesign(repo: Repo, ref: string): Promise<Design> {
  const configText = await repo.show(ref, 'harness/config.json');
  if (configText === undefined) throw new Error(`harness/config.json is missing on ${ref}`);
  const config = parse(ConfigSchema, configText, 'harness/config.json');

  const byModule = new Map<string, ModuleDesign>();
  const moduleOf = (id: string) => {
    if (!byModule.has(id)) byModule.set(id, { id, plans: [], actions: [] });
    return byModule.get(id)!;
  };
  const blobs = await repo.blobs(ref, 'harness/modules');
  for (const path of blobs.keys()) {
    const planFile = /^harness\/modules\/([^/]+)\/plans\/([^/]+)\.json$/.exec(path);
    if (planFile) {
      const [, moduleId, planId] = planFile as unknown as [string, string, string];
      const plan = parse(PlanSchema, (await repo.show(ref, path))!, path);
      if (plan.module !== moduleId || plan.id !== planId) {
        throw new Error(`${path}: its module and id must match its path (found ${plan.module}/${plan.id})`);
      }
      for (const feature of plan.features) {
        const files = feature.checks.flatMap(checkScripts).filter((file) => blobs.has(file));
        if (files.length > 0) scripts.set(feature, Object.fromEntries(files.map((file) => [file, blobs.get(file)!])));
      }
      moduleOf(moduleId).plans.push(plan);
    }
    const actionsFile = /^harness\/modules\/([^/]+)\/owner-actions\.json$/.exec(path);
    if (actionsFile) moduleOf(actionsFile[1]!).actions = parse(z.array(OwnerActionSchema), (await repo.show(ref, path))!, path);
  }
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, 'en', { numeric: true });
  const modules = [...byModule.values()].map((m) => ({ ...m, plans: m.plans.sort(byId) })).sort(byId);
  for (const module of modules) checkReferences(module);
  return { config, modules };
}

/** Every gate a feature names exists, and every action blocks something real. */
function checkReferences(module: ModuleDesign): void {
  const where = `harness/modules/${module.id}`;
  const ids = new Set<string>();
  for (const action of module.actions) {
    if (ids.has(action.id)) throw new Error(`${where}/owner-actions.json: ${action.id} appears twice`);
    ids.add(action.id);
    if (action.kind === 'task' && action.blocks.length > 0) throw new Error(`${where}/owner-actions.json: task ${action.id} blocks work; only a gate can`);
    for (const blocked of action.blocks) {
      const [planId, featureId] = blocked.split('/');
      const plan = module.plans.find((p) => p.id === planId);
      if (!plan || (featureId && !plan.features.some((f) => f.id === featureId))) {
        throw new Error(`${where}/owner-actions.json: ${action.id} blocks ${blocked}, which isn't in the design`);
      }
    }
  }
  const order = module.plans.map((p) => p.id);
  for (const plan of module.plans) {
    const earlier = order.slice(0, order.indexOf(plan.id));
    for (const dep of plan.dependsOn ?? []) {
      if (!earlier.includes(dep)) throw new Error(`${where}/plans/${plan.id}.json: it depends on ${dep}, which is not an earlier plan of ${module.id}`);
    }
    for (const [index, feature] of plan.features.entries()) {
      for (const dep of feature.dependsOn) {
        const target = featureDependency(plan.id, dep);
        if (target.plan === plan.id) {
          // `P2/F01` inside P2 names a feature of the same plan: an earlier one, as without the prefix.
          if (!plan.features.slice(0, index).some((f) => f.id === target.feature)) {
            throw new Error(`${where}/plans/${plan.id}.json: ${feature.id} depends on ${dep}, which is not an earlier feature of ${plan.id}`);
          }
          continue;
        }
        const other = module.plans.find((p) => p.id === target.plan);
        if (!earlier.includes(target.plan) || !other?.features.some((f) => f.id === target.feature)) {
          throw new Error(`${where}/plans/${plan.id}.json: ${feature.id} depends on ${dep}, which is not a feature of an earlier plan of ${module.id}`);
        }
      }
      // Only a feature of an earlier plan can be superseded: one of the same plan is simply changed.
      for (const ref of feature.supersedes) {
        const target = featureDependency(plan.id, ref);
        const other = module.plans.find((p) => p.id === target.plan);
        if (target.plan === plan.id || !earlier.includes(target.plan) || !other?.features.some((f) => f.id === target.feature)) {
          throw new Error(`${where}/plans/${plan.id}.json: ${feature.id} supersedes ${ref}, which is not a feature of an earlier plan of ${module.id}: name it as P1/F01`);
        }
      }
      for (const gate of feature.gates) {
        if (!module.actions.some((a) => a.id === gate && a.kind === 'gate')) {
          throw new Error(`${where}/plans/${plan.id}.json: ${feature.id} waits for gate ${gate}, which owner-actions.json doesn't define`);
        }
      }
    }
  }
}

function parse<T>(schema: z.ZodType<T>, text: string, path: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${(error as Error).message})`);
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new Error(`${path}:\n${z.prettifyError(result.error)}`);
  return result.data;
}
