import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../design/schemas.ts';
import type { SandboxDriver } from '../sandbox/driver.ts';
import { buildPolicy } from '../sandbox/policy.ts';
import { sh } from '../util.ts';

export interface ProbeResult {
  name: string;
  ok: boolean;
  /** Not tried: there was nothing to try it on. */
  skipped?: boolean;
  detail: string;
}

interface ProbeOptions {
  driver: SandboxDriver;
  config: Config;
  /** The state bucket and this project's state key, from the Terraform backend config. */
  state?: { bucket: string; key: string };
  /** A folder on the host for the probe's policy file. */
  scratch: string;
}

/**
 * A conformance test of the layers (proposal v2 §6.2): from a sandbox set up like an
 * agent's, everything it must not do is tried, and each attempt must fail. Nothing is
 * written anywhere: AWS writes are dry runs, or target nothing that exists.
 */
export async function probe(options: ProbeOptions): Promise<ProbeResult[]> {
  const { driver, config } = options;
  const name = `prb-${randomUUID().slice(0, 8)}`;
  const aws = config.aws ? { ...config.aws, services: [...new Set([...config.aws.services, 'sts', 's3', 'ec2', 'secretsmanager'])] } : undefined;
  const policyFile = join(options.scratch, 'probe-policy.yaml');
  writeFileSync(policyFile, `${JSON.stringify(buildPolicy({ ...config.network, ...(aws ? { aws } : {}) }), null, 2)}\n`);
  await driver.create({
    name,
    image: config.sandbox.image,
    providers: [config.sandbox.claudeProvider, ...(aws ? [aws.provider] : [])],
    policyFile,
    env: {
      ...(aws ? { AWS_REGION: aws.region, AWS_DEFAULT_REGION: aws.region, AWS_STS_REGIONAL_ENDPOINTS: 'regional', AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '' } : {}),
    },
    command: ['sleep', 'infinity'],
  });
  const results: ProbeResult[] = [];
  // An agent's commands all run under Claude Code, a listed program (policy.ts). `bash -c`
  // replaces itself with a lone command, which then has no listed ancestor and is refused
  // whatever the host. The `exit` keeps bash as the parent, so the rules apply as they would to an agent.
  const run = async (script: string) => {
    const result = await driver.exec(name, `${script}\nexit $?`, { timeoutSec: 120 });
    return { code: result.code, out: `${result.stdout}${result.stderr}`.trim() };
  };
  /** `denied` decides from the attempt's output whether it was refused the expected way. */
  const expectDenied = async (label: string, script: string, denied: (out: string, code: number) => boolean) => {
    const attempt = await run(script);
    results.push({ name: label, ok: denied(attempt.out, attempt.code), detail: lastLine(attempt.out) });
  };
  // After the control passes, a refused connection means the policy. An L7 refusal is the proxy's 403.
  const notConnected = (out: string, code: number) => code !== 0 || out.endsWith('000');
  const forbidden = (out: string) => out.endsWith('403');

  try {
    // Credentials in the sandbox are placeholders; the proxy holds the real values.
    const env = await run('env | grep -E "^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=" | cut -d= -f1,2 | cut -c1-60');
    const values = env.out.split('\n').filter(Boolean);
    results.push({
      name: 'credentials in the sandbox are placeholders',
      ok: values.length > 0 && values.every((line) => line.includes('openshell:')),
      detail: values.map((line) => `${line.split('=')[0]}=${line.includes('openshell:') ? 'placeholder' : 'A REAL VALUE'}`).join(', ') || 'none found',
    });
    // The control: an allowed request gets through, so the refusals below are the policy, not a
    // network that isn't up yet. A new sandbox's proxy takes a few seconds to apply its policy.
    const allowed = await run('for i in $(seq 1 20); do code="$(curl -s -m 10 -o /dev/null -w "%{http_code}" https://github.com/)"; case "$code" in 2*|3*) echo "$code"; exit 0;; esac; sleep 3; done; echo "$code"; exit 1');
    results.push({ name: 'an allowed host answers (the control)', ok: allowed.code === 0, detail: allowed.out });
    if (allowed.code !== 0) return results;
    await expectDenied('the cloud metadata address is unreachable', 'curl -s -m 8 -o /dev/null -w "%{http_code}" http://169.254.169.254/latest/meta-data/', notConnected);
    await expectDenied('an unlisted host is unreachable', 'curl -s -m 8 -o /dev/null -w "%{http_code}" https://example.org/', notConnected);
    await expectDenied('a POST to a read-only host is refused', 'curl -s -m 8 -o /dev/null -w "%{http_code}" -X POST https://github.com/login', forbidden);
    await expectDenied(
      'git push is refused',
      `curl -s -m 8 -o /dev/null -w "%{http_code}" -X POST https://github.com/${config.project.repo ?? 'octocat/Hello-World'}.git/git-receive-pack`,
      forbidden,
    );
    const user = userInfo().username;
    await expectDenied("the owner's home folder isn't there", `ls ${sh(`/home/${user}`)} 2>&1; test ! -e ${sh(`/home/${user}`)}`, (_out, code) => code === 0);

    if (aws) {
      const identity = await run('aws sts get-caller-identity --query Arn --output text');
      results.push({
        name: 'AWS answers as the view-only role',
        ok: identity.code === 0 && /:assumed-role\/harness-[^/]+-view\//.test(identity.out),
        detail: lastLine(identity.out),
      });
      // A dry run asks only "may I?": EC2 answers UnauthorizedOperation, or DryRunOperation if it would allow it.
      await expectDenied(
        'AWS refuses a write (an EC2 tag, as a dry run)',
        'vpc="$(aws ec2 describe-vpcs --query "Vpcs[0].VpcId" --output text)" && aws ec2 create-tags --dry-run --resources "$vpc" --tags Key=harness-probe,Value=1',
        (out) => /UnauthorizedOperation|AccessDenied/.test(out) && !/DryRunOperation/.test(out),
      );
      await expectDenied(
        'AWS refuses a secret value',
        'aws secretsmanager get-secret-value --secret-id harness-probe-does-not-exist',
        (out) => /AccessDenied/.test(out),
      );
      if (options.state) {
        const { bucket, key } = options.state;
        // The role may list the bucket, so S3 answers 404 for a missing key, deny or not:
        // the attempt is on a state that exists. A byte at most, thrown away.
        const label = "AWS refuses another project's state";
        const listed = await run(`aws s3api list-objects-v2 --bucket ${sh(bucket)} --query 'Contents[].Key' --output text`);
        const other = listed.out.split(/\s+/).find((object) => object.endsWith('.tfstate') && object !== key);
        if (listed.code !== 0) {
          results.push({ name: label, ok: false, detail: lastLine(listed.out) });
        } else if (!other) {
          results.push({ name: label, ok: true, skipped: true, detail: 'the bucket holds no other state to try' });
        } else {
          await expectDenied(
            label,
            `aws s3api get-object --bucket ${sh(bucket)} --key ${sh(other)} --range bytes=0-0 /dev/null`,
            (out) => /AccessDenied/.test(out),
          );
        }
        const own = await run(`aws s3api head-object --bucket ${sh(bucket)} --key ${sh(key)} --query ContentLength --output text`);
        results.push({
          name: "the project's own state is readable",
          ok: own.code === 0 || /Not Found|404/.test(own.out),
          detail: own.code === 0 ? `${own.out} bytes` : `${lastLine(own.out)} (no state yet)`,
        });
      }
    }
  } finally {
    await driver.remove(name);
  }
  return results;
}

/** The bucket and key in a Terraform S3 backend config file. */
export function stateLocation(text: string): { bucket: string; key: string } | undefined {
  const bucket = /^\s*bucket\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  const key = /^\s*key\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  return bucket && key ? { bucket, key } : undefined;
}

function lastLine(text: string): string {
  return (text.split('\n').filter((line) => line.trim() !== '').at(-1) ?? '').slice(0, 160);
}
