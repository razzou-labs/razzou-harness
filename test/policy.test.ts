import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ConfigSchema } from '../src/design/schemas.ts';
import { checkoutId } from '../src/daemon/refs.ts';
import { CHECKOUT_LABEL, PROJECT_LABEL, type ExecResult, type SandboxDriver, type SandboxSpec } from '../src/sandbox/driver.ts';
import { probe } from '../src/setup/probe.ts';
import { tempDir } from './helpers/toy-repo.ts';

describe("the agents' image", () => {
  const dockerfile = readFileSync(new URL('../images/agent/Dockerfile', import.meta.url), 'utf8');

  it("carries zip, which CI's runners have and checks use", () => {
    const packages = /apt-get install[^\n]*\n([\s\S]*?)&&/.exec(dockerfile)?.[1]?.split(/\s+/) ?? [];
    for (const tool of ['zip', 'unzip', 'git', 'curl', 'jq', 'make']) assert.ok(packages.includes(tool), tool);
  });

  it('pins its base image by digest', () => {
    assert.match(dockerfile, /^FROM ubuntu:24\.04@sha256:[0-9a-f]{64}$/m);
  });
});

describe('the probe', () => {
  /** A sandbox that answers each probe the way OpenShell's refusals do. `metadata` is what curl prints for 169.254.169.254. */
  function fakeDriver(metadata: string) {
    const created: SandboxSpec[] = [];
    const scripts: string[] = [];
    const answer = (script: string): Partial<ExecResult> => {
      if (script.startsWith('env ')) return { stdout: 'CLAUDE_CODE_OAUTH_TOKEN=openshell:abc\nAWS_ACCESS_KEY_ID=openshell:def\n' };
      if (script.includes('https://github.com/)')) return { stdout: '200' };
      if (script.includes('id -u')) return { stdout: '1500 agent\n' };
      if (script.includes('169.254.169.254')) return { stdout: metadata };
      if (/ https:\/\/example\.org\//.test(script)) return { code: 6, stdout: '000' };
      if (script.includes('-X POST') || script.includes('-X PUT')) return { stdout: '403' };
      if (script.startsWith('ls ')) return { stdout: 'No such file or directory' };
      if (script.includes('get-caller-identity --query Arn')) return { stdout: 'arn:aws:sts::000000000000:assumed-role/harness-shop-view/probe\n' };
      if (script.includes('dynamodb list-tables')) return { stdout: '' };
      if (script.includes('create-tags')) return { code: 254, stderr: 'An error occurred (UnauthorizedOperation)' };
      if (script.includes('get-secret-value')) return { code: 254, stdout: 'secret prod-db\n', stderr: 'An error occurred (AccessDeniedException)' };
      return { code: 1, stderr: `unexpected: ${script}` };
    };
    const driver = {
      create: async (spec: SandboxSpec) => void created.push(spec),
      exec: async (_name: string, script: string) => {
        scripts.push(script);
        return { code: 0, stdout: '', stderr: '', ...answer(script.replace(/\nexit \$\?$/, '')) };
      },
      remove: async () => {},
    } as unknown as SandboxDriver;
    return { driver, created, scripts };
  }

  const config = ConfigSchema.parse({
    harnessVersion: '0.6.0',
    project: { name: 'shop' },
    network: { bundles: ['core', 'node'], apis: [{ host: 'api.stripe.com', key: 'STRIPE_API_KEY' }] },
    aws: { region: 'eu-west-1', provider: 'aws-view-shop' },
  });

  it("is made like a real sandbox, and tries a plain read-only host, npm's publish, DynamoDB and a real secret", async () => {
    const { driver, created, scripts } = fakeDriver('403 0');
    const projectDir = tempDir('shop');
    const results = await probe({ driver, config, projectDir, scratch: tempDir('probe') });
    // Named and labeled as the daemon names its own: by the project, and this checkout of it.
    assert.deepEqual(created[0]!.labels, { [PROJECT_LABEL]: 'shop', [CHECKOUT_LABEL]: checkoutId(projectDir) });
    assert.deepEqual(created[0]!.providers, ['claude-sub', 'aws-view-shop', `api-shop-${checkoutId(projectDir)}-api-stripe-com`]);
    const byName = new Map(results.map((r) => [r.name, r]));
    for (const name of [
      'the sandbox runs as a user other than root',
      'the cloud metadata address is unreachable',
      "a POST to github.com outside a repository's fetch is refused",
      'a POST to a read-only host (stackoverflow.com) is refused',
      'a PUT to the npm registry (a publish) is refused',
      "DynamoDB's account endpoint answers the view role",
      'AWS refuses a secret value',
    ]) {
      assert.equal(byName.get(name)?.ok, true, `${name}: ${byName.get(name)?.detail}`);
    }
    assert.equal(byName.get('the sandbox runs as a user other than root')!.detail, 'uid 1500 agent');
    assert.ok(results.every((r) => r.ok && !r.skipped), JSON.stringify(results.filter((r) => !r.ok || r.skipped)));
    assert.ok(scripts.some((s) => s.includes('list-secrets') && s.includes('get-secret-value')));
    assert.ok(scripts.some((s) => s.includes('AWS_ACCOUNT_ID_ENDPOINT_MODE=required aws dynamodb list-tables')));
  });

  it('says nothing answers at the metadata address when it times out, rather than passing it as refused', async () => {
    const metadata = (await probe({ driver: fakeDriver('000 28').driver, config, projectDir: tempDir('shop'), scratch: tempDir('probe') })).find((r) => r.name === 'the cloud metadata address is unreachable');
    assert.deepEqual([metadata?.skipped, metadata?.detail], [true, 'nothing answers there on this machine, so the refusal is untested']);
    const answered = (await probe({ driver: fakeDriver('200 0').driver, config, projectDir: tempDir('shop'), scratch: tempDir('probe') })).find((r) => r.name === 'the cloud metadata address is unreachable');
    assert.equal(answered?.ok, false);
  });
});
