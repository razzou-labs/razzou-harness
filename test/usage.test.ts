import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { usageFromEvent, windowName } from '../src/anthropic/usage.ts';

/** A line from a reviewer's stream-json, as Claude Code 2.1 writes it after a model call. */
const EVENT = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed', resetsAt: 1794247200, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.585, resetsAt: 1794247200, status: 'allowed' },
      seven_day: { utilization: 0.57, resetsAt: 1794556800, status: 'allowed' },
    },
  },
  uuid: '91073636-61ad-4684-b7d0-a44a7bd0d897',
  session_id: 'ab417748-11ad-4895-b35a-7615c9f7e576',
};

describe("the subscription's usage, as the agents report it", () => {
  it('reads the session and weekly windows of a rate_limit_event, as percentages with their resets', () => {
    const usage = usageFromEvent(EVENT)!;
    assert.deepEqual(usage.limits, [
      { kind: 'session', percent: 59, resetsAt: '2026-11-09T18:00:00.000Z' },
      { kind: 'weekly_all', percent: 57, resetsAt: '2026-11-13T08:00:00.000Z' },
    ]);
    assert.deepEqual([usage.percent, usage.resetsAt], [59, '2026-11-09T18:00:00.000Z'], 'the highest window binds');
  });

  it('keeps a window Claude Code adds under its own name, and skips one without numbers', () => {
    const usage = usageFromEvent({
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: 1794556800 }, seven_day_fable: { utilization: 0.9, resetsAt: 1794556800 }, five_hour: null } },
    })!;
    assert.deepEqual(usage.limits.map((l) => [l.kind, l.percent]), [['weekly_all', 20], ['seven_day_fable', 90]]);
    assert.equal(usage.percent, 90);
  });

  it('reads a plan without a session limit: the weekly window alone, which binds', () => {
    const usage = usageFromEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.31, resetsAt: 1794556800, status: 'allowed' } } } })!;
    assert.deepEqual(usage.limits, [{ kind: 'weekly_all', percent: 31, resetsAt: '2026-11-13T08:00:00.000Z' }]);
    assert.deepEqual([usage.percent, usage.resetsAt], [31, '2026-11-13T08:00:00.000Z']);
  });

  it('reads the window an event names at its top when it has no unifiedWindows, if it gives its numbers', () => {
    const top = (info: object) => usageFromEvent({ type: 'rate_limit_event', rate_limit_info: info });
    assert.deepEqual(top({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.76, resetsAt: 1794556800 })!.limits, [
      { kind: 'weekly_all', percent: 76, resetsAt: '2026-11-13T08:00:00.000Z' },
    ]);
    assert.equal(top({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1794318600 }), undefined, 'without its utilization');
  });

  it('names the windows for messages', () => {
    assert.deepEqual(['session', 'weekly_all', 'seven_day_opus'].map(windowName), ['the five-hour session', 'the weekly window', 'the seven day opus window']);
  });

  it('is nothing for any other line, or an event without a window', () => {
    assert.equal(usageFromEvent({ type: 'assistant', message: {} }), undefined);
    assert.equal(usageFromEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), undefined);
    assert.equal(usageFromEvent(null), undefined);
  });
});
