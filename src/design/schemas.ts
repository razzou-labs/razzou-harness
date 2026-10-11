import { z } from 'zod';
import type { Repo } from '../git/repo.ts';
import { canonicalJson, sha256 } from '../util.ts';

/** Ids end up in branch names, refs and sandbox names, so they stay short and plain. */
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/, 'use letters, digits and dashes (at most 40)');

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
  dependsOn: z.array(Id).default([]),
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
    features: z.array(FeatureSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    for (const feature of plan.features) {
      if (seen.has(feature.id)) ctx.addIssue({ code: 'custom', message: `feature ${feature.id} appears twice` });
      for (const dep of feature.dependsOn) {
        if (!seen.has(dep)) ctx.addIssue({ code: 'custom', message: `${feature.id} depends on ${dep}, which is not an earlier feature of this plan` });
      }
      seen.add(feature.id);
    }
  });
export type Plan = z.infer<typeof PlanSchema>;

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
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default('xhigh'),
          attemptTimeoutMinutes: z.number().int().positive().max(600).default(90),
          maxAttempts: z.number().int().min(1).max(5).default(2),
        })
        .prefault({}),
      manager: z
        .object({
          agent: z.enum(['claude-code']).default('claude-code'),
          model: z.string().default('claude-opus-5-5'),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default('high'),
        })
        .prefault({}),
      architect: z
        .object({
          agent: z.enum(['claude-code']).default('claude-code'),
          model: z.string().default('claude-opus-5-5'),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default('max'),
        })
        .prefault({}),
    })
    .prefault({}),
  sandbox: z
    .object({
      image: z.string().default('razzou-harness/agent:0.1.0'),
      claudeProvider: z.string().default('claude-sub'),
      env: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
  network: z
    .object({
      bundles: z.array(z.string()).default(['core']),
      extraHosts: z.array(z.string()).default([]),
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
      /** The services the project uses: their endpoints are reachable, and signed. */
      services: z.array(z.string().regex(/^[a-z0-9-]+$/)).default(['sts', 's3', 'iam']),
    })
    .optional(),
  /** Where the project's Terraform lives, and how a plan is made against the real state (§12.4). */
  terraform: z
    .object({
      dir: z.string().default('iac'),
      backendConfig: z.string().default('backend-configs/staging.hcl'),
      varFile: z.string().default('env/staging.tfvars'),
    })
    .optional(),
  brakes: z
    .object({
      consecutiveFailures: z.number().int().min(1).default(3),
      /** How long an item may wait for the Manager before a reminder; as long again, and the pipeline pauses. */
      managerTurnMinutes: z.number().int().min(1).max(240).default(20),
      /** Fix rounds for a pull request whose CI fails, before the owner decides. */
      ciFixRounds: z.number().int().min(0).max(5).default(2),
      /** Fix PRs after a failed apply or failed post-deploy checks, before the owner decides. */
      deployFixRounds: z.number().int().min(0).max(5).default(2),
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

/**
 * The hash of a feature's definition: its JSON, and the design files its checks run. A
 * changed definition, a fixed check script among them, starts a fresh attempt budget.
 */
export function definitionHash(feature: Feature): string {
  const files = scripts.get(feature);
  return sha256(canonicalJson(files ? { feature, files } : feature));
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
  for (const plan of module.plans) {
    for (const feature of plan.features) {
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
