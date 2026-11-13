import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { GitHubError, type GitHubClient } from '../src/github/app.ts';
import { GitHubForge, GITHUB_ACTIONS } from '../src/github/forge.ts';

/** A zip of one deflated file, as GitHub serves an artifact. */
function zipOf(name: string, text: string): Buffer {
  const data = deflateRawSync(Buffer.from(text, 'utf8'));
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(nameBytes.length, 26);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt32LE(data.length, 20);
  entry.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBytes.length, 12);
  end.writeUInt32LE(30 + nameBytes.length + data.length, 16);
  return Buffer.concat([local, nameBytes, data, entry, nameBytes, end]);
}

/**
 * A stand-in for the App's client: each call goes to `answer`, by method and path, and is
 * recorded. What `answer` throws, GitHub refused.
 */
function forgeWith(answer: (method: string, path: string, body?: any) => unknown) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const client = {
    repo: 'acme/shop',
    canWriteStatuses: true,
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      return answer(method, path, body);
    },
    async download(path: string) {
      calls.push({ method: 'GET', path });
      return answer('GET', path) as string;
    },
    async downloadBytes(path: string) {
      calls.push({ method: 'GET', path });
      return answer('GET', path) as Buffer;
    },
    async token() {
      return 't';
    },
  };
  return { forge: new GitHubForge(client as unknown as GitHubClient), calls };
}

describe('the forge on GitHub', () => {
  it("keeps only GitHub Actions' check runs, each with its workflow run and when it completed", async () => {
    const { forge } = forgeWith(() => ({
      check_runs: [
        { id: 11, name: 'cost', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/shop/actions/runs/700/job/11', completed_at: '2026-11-01T10:00:00Z', app: { id: GITHUB_ACTIONS } },
        // Another App with checks permission, posting a run named like a job.
        { id: 12, name: 'cost', status: 'completed', conclusion: 'success', html_url: 'https://example.test/12', completed_at: '2026-11-01T10:05:00Z', app: { id: 999 } },
        { id: 13, name: 'verify', status: 'in_progress', conclusion: null, app: null },
      ],
    }));
    assert.deepEqual(await forge.checkRuns('abc'), [
      { id: 11, name: 'cost', status: 'completed', conclusion: 'success', url: 'https://github.com/acme/shop/actions/runs/700/job/11', runId: 700, completedAt: '2026-11-01T10:00:00Z' },
    ]);
  });

  it("reads the artifact of the job's own run, and refuses one made after the job completed", async () => {
    const artifacts: Record<number, object[]> = {
      700: [{ id: 5, name: 'cost', expired: false, created_at: '2026-11-01T09:59:00Z', updated_at: '2026-11-01T09:59:30Z' }],
      701: [{ id: 6, name: 'cost', expired: false, created_at: '2026-11-01T10:30:00Z', updated_at: '2026-11-01T10:30:00Z' }],
    };
    const { forge, calls } = forgeWith((_method, path) => {
      const run = /\/actions\/runs\/(\d+)\/artifacts/.exec(path)?.[1];
      if (run) return { artifacts: artifacts[Number(run)] ?? [] };
      if (path.includes('/actions/runs?')) return { workflow_runs: [{ id: 700, status: 'completed', created_at: '2026-11-01T09:00:00Z' }, { id: 701, status: 'completed', created_at: '2026-11-01T10:20:00Z' }] };
      const artifact = /\/actions\/artifacts\/(\d+)\/zip/.exec(path)?.[1];
      if (artifact) return zipOf('cost.json', `{"from":${artifact}}`);
      throw new Error(`unexpected ${path}`);
    });
    assert.equal(await forge.artifactFile('abc', 'cost', 'cost.json', { runId: 700, notAfter: '2026-11-01T10:00:00Z' }), '{"from":5}');
    assert.ok(!calls.some((c) => c.path.includes('/actions/runs?')), 'with a run, no other run is looked at');
    await assert.rejects(forge.artifactFile('abc', 'cost', 'cost.json', { runId: 701, notAfter: '2026-11-01T10:00:00Z' }), /made at 2026-11-01T10:30:00Z, after 2026-11-01T10:00:00Z: another job replaced it/);
    assert.equal(await forge.artifactFile('abc', 'cost', 'cost.json', { runId: 702 }), undefined);
    await assert.rejects(forge.artifactFile('abc', 'cost', 'cost.json', { runId: 700, maxBytes: 4 }), /holds more than 4 bytes/);
    // Without a run, the newest completed run that has one.
    assert.equal(await forge.artifactFile('abc', 'cost', 'cost.json'), '{"from":6}');
  });

  it('folds the comments GitHub refuses into the review body, and passes on any other refusal', async () => {
    const posted: any[] = [];
    let refuse = (body: any) => body.comments.length > 0 ? new GitHubError('Unprocessable Entity: line must be part of the diff', 422) : undefined;
    const { forge } = forgeWith((_method, _path, body) => {
      posted.push(body);
      const error = refuse(body);
      if (error) throw error;
      return {};
    });
    const review = { head: 'abc', body: 'Two findings.', comments: [{ path: 'src/a.ts', line: 3, body: 'An injection.' }] };
    assert.deepEqual(await forge.createReview(7, review), { comments: 0 });
    assert.equal(posted.length, 2);
    assert.deepEqual(posted[1].comments, []);
    assert.equal(posted[1].body, 'Two findings.\n\n**src/a.ts:3** An injection.');
    refuse = () => new GitHubError('Forbidden', 403);
    await assert.rejects(forge.createReview(7, review), (error: unknown) => error instanceof GitHubError && error.status === 403);
  });

  it("passes on GitHub's refusal to merge, and a merge it says didn't happen", async () => {
    const refusing = forgeWith(() => {
      throw new GitHubError('PUT /repos/acme/shop/pulls/7/merge: 405 Required status check "verify" is expected.', 405);
    });
    await assert.rejects(refusing.forge.mergePullRequest(7, 'abc'), (error: unknown) => error instanceof GitHubError && error.status === 405);
    assert.deepEqual(refusing.calls[0]!.body, { merge_method: 'merge', sha: 'abc' });
    const unmerged = forgeWith(() => ({ sha: '', merged: false, message: 'Pull Request is not mergeable' }));
    await assert.rejects(unmerged.forge.mergePullRequest(7, 'abc'), /Pull Request is not mergeable/);
  });

  it("takes the end of a job's log before the clean-up that ends it", async () => {
    const failure = `${'2026-11-01T10:00:00Z noise\n'.repeat(400)}2026-11-01T10:01:00Z AssertionError: expected 5, got 4\n2026-11-01T10:01:01Z ##[error]Process completed with exit code 1.\n`;
    const cleanup = `2026-11-01T10:01:02Z Post job cleanup.\n${'2026-11-01T10:01:03Z [command]/usr/bin/git config --local --unset-all http.https://github.com/.extraheader\n'.repeat(80)}`;
    const { forge } = forgeWith(() => `${failure}${cleanup}`);
    const log = await forge.jobLog({ id: 11, name: 'checks', status: 'completed', conclusion: 'failure' });
    assert.ok(log.endsWith('##[error]Process completed with exit code 1.\n'), log.slice(-200));
    assert.match(log, /expected 5, got 4/);
    assert.ok(log.length <= 4001, `${log.length}`);
  });

  it("finds a branch's pull request, a closed or merged one only when its head is the commit pushed", async () => {
    const prs = [
      { number: 9, html_url: 'https://github.com/acme/shop/pull/9', state: 'closed', head: { sha: 'old' } },
      { number: 3, html_url: 'https://github.com/acme/shop/pull/3', state: 'closed', head: { sha: 'new' } },
    ];
    const { forge, calls } = forgeWith(() => prs);
    assert.deepEqual(await forge.findPullRequest('plan/shop/P1'), { number: 9, url: 'https://github.com/acme/shop/pull/9' });
    assert.deepEqual(await forge.findPullRequest('plan/shop/P1', { head: 'new' }), { number: 3, url: 'https://github.com/acme/shop/pull/3' });
    assert.equal(await forge.findPullRequest('plan/shop/P1', { head: 'other' }), undefined);
    assert.match(calls[0]!.path, /state=all&head=acme%3Aplan%2Fshop%2FP1$/);
    prs.unshift({ number: 12, html_url: 'https://github.com/acme/shop/pull/12', state: 'open', head: { sha: 'moved' } });
    assert.equal((await forge.findPullRequest('plan/shop/P1', { head: 'other' }))?.number, 12, 'an open one counts whatever its head');
  });
});
