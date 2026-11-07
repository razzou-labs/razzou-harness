import { strict as assert } from 'node:assert';
import { statSync } from 'node:fs';
import { describe, it } from 'node:test';
import { claudeTokenFile, loadClaudeToken, parseUsage, readUsage, saveClaudeToken, USAGE_URL } from '../src/anthropic/usage.ts';
import { tempDir } from './helpers/toy-repo.ts';

/** The shape spike 5 recorded, trimmed to what the daemon reads. */
const BODY = {
  five_hour: { utilization: 51, resets_at: '2026-11-05T19:49:59+00:00' },
  seven_day: { utilization: 55, resets_at: '2026-11-06T07:59:59+00:00' },
  limits: [
    { kind: 'session', percent: 51, severity: 'normal', resets_at: '2026-11-05T19:49:59+00:00', is_active: false },
    { kind: 'weekly_all', percent: 55, severity: 'normal', resets_at: '2026-11-06T07:59:59+00:00', is_active: true },
    { kind: 'weekly_scoped', percent: 8, severity: 'normal', resets_at: '2026-11-06T07:59:59+00:00', scope: { model: { display_name: 'Fable' } } },
  ],
};

describe('the subscription\'s usage', () => {
  it('reads the binding window from the limits the endpoint lists', () => {
    const usage = parseUsage(BODY);
    assert.equal(usage.percent, 55);
    assert.equal(usage.resetsAt, '2026-11-06T07:59:59+00:00');
    assert.deepEqual(usage.limits.map((l) => [l.kind, l.percent]), [['session', 51], ['weekly_all', 55], ['weekly_scoped', 8]]);
  });

  it('falls back to the two windows the body always carries, and refuses a body without any', () => {
    const { limits: _, ...windows } = BODY;
    assert.deepEqual(parseUsage(windows).limits.map((l) => [l.kind, l.percent]), [['session', 51], ['weekly_all', 55]]);
    assert.throws(() => parseUsage({}), /without any limit/);
  });

  it('calls the endpoint with the token, the beta header and a timeout, and refuses any other answer', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; signal?: AbortSignal | null }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string>, signal: init?.signal });
      return new Response(JSON.stringify(BODY), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const usage = await readUsage('sk-ant-test', fetchImpl);
    assert.equal(usage.percent, 55);
    assert.equal(calls[0]!.url, USAGE_URL);
    assert.equal(calls[0]!.headers.authorization, 'Bearer sk-ant-test');
    assert.equal(calls[0]!.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.ok(calls[0]!.signal instanceof AbortSignal, 'a hung endpoint times out');
    const refused = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    await assert.rejects(readUsage('sk-ant-test', refused), /answered 401/);
  });

  it('stores the token for the daemon alone, and reads it back', () => {
    const dir = tempDir('config');
    assert.equal(loadClaudeToken(dir), undefined);
    const file = saveClaudeToken('  sk-ant-stored \n', dir);
    assert.equal(file, claudeTokenFile(dir));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(loadClaudeToken(dir), 'sk-ant-stored');
  });
});
