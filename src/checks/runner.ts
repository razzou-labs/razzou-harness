import type { Check } from '../design/schemas.ts';
import type { SandboxDriver } from '../sandbox/driver.ts';
import { sh, tail } from '../util.ts';

export interface CheckResult {
  id: string;
  exit: number;
  durationMs: number;
  timedOut: boolean;
  /** The end of the combined output, enough to see why a check failed. */
  output: string;
}

export const allPassed = (results: CheckResult[]) => results.every((r) => r.exit === 0);

/** Where the project's Terraform is, for checks that assert on a plan (§8.3, §12.4). */
export interface TerraformSetup {
  dir: string;
  backendConfig: string;
  varFile: string;
}

export interface RunOptions {
  terraform?: TerraformSetup;
  /** A folder in the sandbox for the plan and its logs. */
  scratchDir?: string;
}

/**
 * Runs checks one by one in a sandbox, from the repository root. Each gets its own
 * timeout inside the sandbox; the exec's own timeout is only a backstop. Checks that
 * need a Terraform plan get it in `$HARNESS_PLAN_JSON`, made once before them with
 * `plan -lock=false` against the real state.
 */
export async function runChecks(driver: SandboxDriver, sandbox: string, workDir: string, checks: Check[], options: RunOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let planJson: string | undefined;
  if (checks.some((c) => c.needs.includes('tfplan'))) {
    const plan = await makePlan(driver, sandbox, workDir, options);
    if (plan.exit !== 0) {
      results.push(plan);
      for (const check of checks.filter((c) => c.needs.includes('tfplan'))) {
        results.push({ id: check.id, exit: 1, durationMs: 0, timedOut: false, output: 'not run: the Terraform plan failed (see terraform-plan)' });
      }
    } else {
      planJson = `${options.scratchDir}/plan.json`;
    }
  }
  for (const check of checks) {
    if (check.needs.includes('tfplan') && !planJson) continue;
    const env = check.needs.includes('tfplan') ? `HARNESS_PLAN_JSON=${sh(planJson!)} ` : '';
    const started = Date.now();
    const script = `cd ${sh(workDir)} && ${env}timeout --kill-after=10 ${check.timeoutSec} bash -c ${sh(check.run)} 2>&1`;
    const result = await driver.exec(sandbox, script, { timeoutSec: check.timeoutSec + 60 });
    results.push({
      id: check.id,
      exit: result.code,
      durationMs: Date.now() - started,
      timedOut: result.code === 124 || result.code === 137,
      output: tail(`${result.stdout}${result.stderr}`, 4000),
    });
  }
  return results;
}

/** `terraform plan -lock=false` with the real backend: the view role reads the state, and can't take the lock (§12.4). */
async function makePlan(driver: SandboxDriver, sandbox: string, workDir: string, options: RunOptions): Promise<CheckResult> {
  const started = Date.now();
  const tf = options.terraform;
  if (!tf || !options.scratchDir) {
    return { id: 'terraform-plan', exit: 1, durationMs: 0, timedOut: false, output: 'a check needs a Terraform plan, but harness/config.json has no terraform section' };
  }
  const out = options.scratchDir;
  const script = [
    `cd ${sh(`${workDir}/${tf.dir}`)} || exit 1`,
    `terraform init -input=false -no-color -backend-config=${sh(tf.backendConfig)} > ${sh(`${out}/terraform-init.log`)} 2>&1 || { tail -c 3000 ${sh(`${out}/terraform-init.log`)}; exit 1; }`,
    `terraform plan -input=false -no-color -lock=false -var-file=${sh(tf.varFile)} -out=${sh(`${out}/plan.bin`)} > ${sh(`${out}/terraform-plan.log`)} 2>&1 || { tail -c 3000 ${sh(`${out}/terraform-plan.log`)}; exit 1; }`,
    `terraform show -json ${sh(`${out}/plan.bin`)} > ${sh(`${out}/plan.json`)}`,
    `grep -E '^(Plan:|No changes)' ${sh(`${out}/terraform-plan.log`)} || true`,
  ].join('\n');
  const result = await driver.exec(sandbox, script, { timeoutSec: 900 });
  return { id: 'terraform-plan', exit: result.code, durationMs: Date.now() - started, timedOut: false, output: tail(`${result.stdout}${result.stderr}`, 4000) };
}

/** Runs the project's `init.sh` when there is one. It prepares the environment: dependencies, build, local services. */
export async function initEnvironment(driver: SandboxDriver, sandbox: string, workDir: string): Promise<CheckResult | undefined> {
  const exists = await driver.exec(sandbox, `test -f ${sh(`${workDir}/init.sh`)}`);
  if (exists.code !== 0) return undefined;
  const [result] = await runChecks(driver, sandbox, workDir, [
    { id: 'init.sh', run: 'bash init.sh', phase: 'pre-merge', timeoutSec: 900, needs: [] },
  ]);
  return result;
}
