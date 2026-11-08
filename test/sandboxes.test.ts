import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bytes, readDockerUsage } from '../src/sandbox/docker.ts';
import { OpenShellDriver } from '../src/sandbox/openshell.ts';
import { Denials, parseDenials } from '../src/sandbox/refusals.ts';
import { storeApiKey } from '../src/setup/doctor.ts';
import { buildCache, removeOldAgentImages } from '../src/setup/images.ts';
import { tempDir } from './helpers/toy-repo.ts';

/** Lines of `openshell logs`, as OpenShell 0.1.2 wrote them for a sandbox whose policy refused two hosts. */
const LOG = [
  '[1794077340.958] [sandbox] [OCSF ] [ocsf] CONFIG:LOADED [INFO] Acknowledged initial policy revision as loaded [version:1] [hash:a45a8ff3]',
  '[1794077355.552] [sandbox] [OCSF ] [ocsf] SSH:OPEN [INFO] ALLOWED',
  '[1794077355.596] [sandbox] [OCSF ] [ocsf] NET:REFUSE [MED] DENIED example.com [reason:policy_dns_ineligible]',
  '[1794077355.601] [sandbox] [WARN ] [openshell_supervisor_network::proxy] Denied staged transparent connection destination=198.18.0.2:443 reason=network connections not allowed by policy',
  '[1794077355.601] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(0) -> example.com:443 [reason:transparent_tcp_policy_denied]',
  '[1794077355.609] [sandbox] [OCSF ] [ocsf] NET:REFUSE [MED] DENIED registry.npmjs.org [reason:policy_dns_ineligible]',
  '[1794077356.001] [sandbox] [OCSF ] [ocsf] NET:REFUSE [MED] DENIED pypi.org [reason:policy_dns_ineligible]',
  '[1794077357.610] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(12) -> registry.npmjs.org:443 [reason:transparent_tcp_policy_denied]',
  '[1794077358.610] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(13) -> registry.npmjs.org:443 [reason:transparent_tcp_policy_denied]',
].join('\n');

describe('the sandboxes view', () => {
  it("counts the requests a sandbox's policy refused, and a DNS query only when no connection to its host was logged", () => {
    assert.deepEqual(parseDenials(LOG), [
      { program: '/usr/bin/curl', target: 'registry.npmjs.org:443', reason: 'transparent_tcp_policy_denied', count: 2, last: new Date(1794077358610).toISOString() },
      { target: 'pypi.org', reason: 'policy_dns_ineligible', count: 1, last: new Date(1794077356001).toISOString() },
      { program: '/usr/bin/curl', target: 'example.com:443', reason: 'transparent_tcp_policy_denied', count: 1, last: new Date(1794077355601).toISOString() },
    ]);
    assert.deepEqual(parseDenials('a line that says DENIED nothing\n\n[x] [ocsf] DENIED  [reason:r]'), []);
  });

  it("adds up readings of a log that overlap, as OpenShell's last lines move on, counting each refusal once", () => {
    const lines = LOG.split('\n');
    // Two refusals in the same millisecond, the first of them at the end of the first reading.
    const twin = '[1794077358.610] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(14) -> registry.npmjs.org:443 [reason:transparent_tcp_policy_denied]';
    const later = '[1794077359.000] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/git(15) -> example.org:443 [reason:transparent_tcp_policy_denied]';
    const all = [...lines, twin, later];
    const denials = new Denials().add(lines.slice(0, 6).join('\n')).add(lines.slice(2).join('\n')).add(all.slice(5).join('\n')).add(all.slice(-2).join('\n'));
    assert.deepEqual(denials.list(), parseDenials(all.join('\n')));
    assert.deepEqual(denials.list().map((d) => [d.target, d.count]), [['example.org:443', 1], ['registry.npmjs.org:443', 3], ['pypi.org', 1], ['example.com:443', 1]]);
    // A reading with nothing new, and one of lines older than any counted, change nothing.
    assert.deepEqual(denials.add('').add(lines.slice(0, 3).join('\n')).list(), parseDenials(all.join('\n')));
  });

  it('reads what each sandbox uses from Docker, with its caps, and the total with the supervisors', async () => {
    const dir = tempDir('docker');
    const bin = join(dir, 'docker');
    const stats = [
      { ID: 'aaaaaaaaaaaa', CPUPerc: '149.39%', MemUsage: '5.656MiB / 2GiB', PIDs: '44' },
      { ID: 'bbbbbbbbbbbb', CPUPerc: '7.84%', MemUsage: '36.03MiB / 62.24GiB', PIDs: '25' },
      { ID: 'cccccccccccc', CPUPerc: '0.50%', MemUsage: '1.5GiB / 62.24GiB', PIDs: '9' },
    ].map((line) => JSON.stringify(line)).join('\n');
    writeFileSync(bin, [
      '#!/bin/sh',
      'case "$1" in',
      "  ps) printf 'aaaaaaaaaaaa\\tdev-1a2b3c4d-a1\\tsandbox\\nbbbbbbbbbbbb\\tdev-1a2b3c4d-a1\\tsupervisor\\ncccccccccccc\\tarc-9f8e7d6c\\tsandbox\\n' ;;",
      `  stats) echo '${stats}' ;;`,
      `  inspect) printf '${'a'.repeat(64)}\\t1500000000\\t2147483648\\n${'b'.repeat(64)}\\t0\\t0\\n${'c'.repeat(64)}\\t0\\t0\\n' ;;`,
      '  *) exit 2 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    const reading = await readDockerUsage(bin, () => Date.parse('2026-11-08T12:00:00Z'));
    assert.deepEqual(reading.sandboxes, {
      'dev-1a2b3c4d-a1': { cpu: 1.4939, memoryBytes: Math.round(5.656 * 1024 ** 2), cpuLimit: 1.5, memoryLimitBytes: 2 * 1024 ** 3 },
      'arc-9f8e7d6c': { cpu: 0.005, memoryBytes: 1.5 * 1024 ** 3 },
    });
    assert.equal(reading.total.cpu.toFixed(4), (1.4939 + 0.0784 + 0.005).toFixed(4));
    assert.equal(reading.total.memoryBytes, Math.round(5.656 * 1024 ** 2) + Math.round(36.03 * 1024 ** 2) + 1536 * 1024 ** 2);
    assert.equal(reading.at, '2026-11-08T12:00:00.000Z');
    assert.equal(reading.problem, undefined);
    assert.match((await readDockerUsage(join(dir, 'missing'))).problem!, /^docker ps failed: /);
    assert.deepEqual([bytes('0B'), bytes('512KiB'), bytes('1.2GB'), bytes('nothing')], [0, 512 * 1024, 1.2e9, undefined]);
  });

  it("reads OpenShell's list page by page, its UTC times, and its labels", async () => {
    const dir = tempDir('openshell');
    const page = (sandboxes: object[], next: string) => JSON.stringify({ sandboxes, next_page_token: next });
    writeFileSync(join(dir, 'page1.json'), page([{ name: 'arc-1a2b3c4d', phase: 'Ready', created_at: '2026-11-07 18:49:00', labels: { 'harness.project': 'shop' } }], 'p2'));
    writeFileSync(join(dir, 'page2.json'), page([{ name: 'prb-9f8e7d6c', phase: 'Provisioning', created_at: '', labels: null }], ''));
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ gateway: 'openshell', status: 'connected', version: '0.1.2' }));
    const bin = join(dir, 'openshell');
    writeFileSync(bin, [
      '#!/bin/sh',
      `dir='${dir}'`,
      'echo "$@" >> "$dir/calls"',
      'case "$*" in',
      '  "sandbox list --output json --page-token p2") cat "$dir/page2.json" ;;',
      '  "sandbox list --output json") cat "$dir/page1.json" ;;',
      '  "status --output json") cat "$dir/status.json" ;;',
      `  "provider list --output json") echo '{"providers":[{"name":"claude-sub","credential_keys":["CLAUDE_CODE_OAUTH_TOKEN"]}],"next_page_token":"q2"}' ;;`,
      `  "provider list --output json --page-token q2") echo '{"providers":[{"name":"api-shop-api-stripe-com"}],"next_page_token":""}' ;;`,
      '  logs*) echo "the log" ;;',
      '  "sandbox create"*) ;;',
      '  *) echo "unexpected: $*" >&2; exit 2 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    const driver = new OpenShellDriver(bin);
    assert.deepEqual(await driver.list(), [
      { name: 'arc-1a2b3c4d', phase: 'Ready', createdAt: '2026-11-07T18:49:00Z', labels: { 'harness.project': 'shop' } },
      { name: 'prb-9f8e7d6c', phase: 'Provisioning', labels: {} },
    ]);
    assert.deepEqual(await driver.gateway(), { status: 'connected', version: '0.1.2' });
    assert.deepEqual(await driver.providers(), ['claude-sub', 'api-shop-api-stripe-com']);
    assert.equal(await driver.logs('arc-1a2b3c4d', 50), 'the log\n');
    assert.deepEqual(await new OpenShellDriver(join(dir, 'missing')).gateway().then((g) => g.status), 'unreachable');
    await driver.create({ name: 'dev-1a2b3c4d-a1', image: 'img', providers: [], env: {}, labels: { 'harness.project': 'shop' }, cpu: '1500m', memory: '2048Mi', command: ['sleep', 'infinity'] });
    const created = readFileSync(join(dir, 'calls'), 'utf8').split('\n').find((line) => line.startsWith('sandbox create'));
    assert.equal(created, 'sandbox create --name dev-1a2b3c4d-a1 --from img --detach --label harness.project=shop --cpu 1500m --memory 2048Mi -- sleep infinity');
  });
});

describe("the doctor's cleanup of the agents' images", () => {
  it('removes the images a build replaces that no container uses, leaves any other, and reads the build cache', async () => {
    const dir = tempDir('docker');
    const bin = join(dir, 'docker');
    writeFileSync(bin, [
      '#!/bin/bash',
      `echo "$*" >> '${dir}/calls'`,
      'case "$*" in',
      "  'image ls'*) printf 'razzou-harness/agent:0.4.0\\tid4\\nrazzou-harness/agent:0.3.0\\tid3\\nrazzou-harness/agent:0.2.0\\tid2\\n<none>:<none>\\tid1\\nacme/agent:1\\tida\\n' ;;",
      "  'image rm razzou-harness/agent:0.2.0') echo 'Error response from daemon: conflict: unable to remove repository reference' >&2; exit 1 ;;",
      "  'image rm '*) echo \"Untagged: $3\" ;;",
      `  'system df'*) echo '{"Active":"1","Reclaimable":"1.821GB (93%)","Size":"1.938GB","TotalCount":"6","Type":"Images"}'; echo '{"Active":"0","Reclaimable":"4.102GB","Size":"8.028GB","TotalCount":"50","Type":"Build Cache"}' ;;`,
      '  *) exit 2 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    assert.deepEqual(await removeOldAgentImages('razzou-harness/agent:0.4.0', bin), {
      removed: ['razzou-harness/agent:0.3.0', 'an untagged image (id1)'],
      kept: ['razzou-harness/agent:0.2.0'],
    });
    const removals = readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter((line) => line.startsWith('image rm'));
    assert.deepEqual(removals, ['image rm razzou-harness/agent:0.3.0', 'image rm razzou-harness/agent:0.2.0', 'image rm id1'], 'never the new image, nor another repository\'s');
    assert.deepEqual(await removeOldAgentImages('acme/agent:2', bin), { removed: [], kept: [] }, 'a project with its own image keeps every other');
    assert.deepEqual(await buildCache(bin), { size: '8.028GB', reclaimable: '4.102GB' });
    assert.equal(await buildCache(join(dir, 'missing')), undefined);
  });
});

describe("the doctor's API keys", () => {
  it('stores a key in its own provider, after its profile, through the environment alone', async () => {
    const dir = tempDir('openshell-api');
    const bin = join(dir, 'openshell');
    writeFileSync(bin, [
      '#!/bin/bash',
      `echo "$*" >> '${dir}/calls'`,
      'case "$1 $2" in',
      `  'profile import') cp "$4" '${dir}/profile.json' ;;`,
      `  'provider create') [ "$STRIPE_API_KEY" = 'sk_test_123' ] && echo 'key in the environment' > '${dir}/env' ;;`,
      '  *) ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    assert.equal(await storeApiKey('shop', { host: 'api.stripe.com', key: 'STRIPE_API_KEY' }, 'sk_test_123', bin), undefined);
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
    assert.deepEqual(calls.map((call) => call.replace(/-f \S+/, '-f <file>')), [
      'profile delete api-shop-api-stripe-com --global',
      'profile import -f <file> --global',
      'provider create --name api-shop-api-stripe-com --type api-shop-api-stripe-com --credential STRIPE_API_KEY --global-profile',
    ]);
    assert.ok(!calls.join(' ').includes('sk_test_123'), 'never in the arguments');
    assert.equal(readFileSync(join(dir, 'env'), 'utf8'), 'key in the environment\n');
    const profile = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')) as { id: string; endpoints: Array<{ host: string }> };
    assert.deepEqual([profile.id, profile.endpoints.map((e) => e.host)], ['api-shop-api-stripe-com', ['api.stripe.com']]);
    assert.ok(!existsSync(calls[1]!.split(' ')[3]!), 'the profile file is gone');
  });
});
