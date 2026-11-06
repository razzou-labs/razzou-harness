import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fixFor, parseBundles } from '../src/setup/setup.ts';

describe('harness setup (v4 §4)', () => {
  it('knows which of the doctor\'s findings it can fix, and how', () => {
    const check = (name: string, status: 'ok' | 'warn' | 'fail' | 'skip', detail = '') => ({ name, status, detail });
    assert.equal(fixFor(check('Node', 'fail', '20.1.0')), undefined);
    assert.equal(fixFor(check('OpenShell gateway', 'ok', 'connected')), undefined);
    assert.deepEqual(fixFor(check('OpenShell gateway', 'fail', 'not running')), { kind: 'start-gateway' });
    assert.deepEqual(fixFor(check('image', 'fail', "razzou-harness/agent:1 isn't built")), { kind: 'build-image' });
    assert.deepEqual(fixFor(check('image', 'warn', 'has Claude Code 1, this machine 2')), { kind: 'build-image' });
    assert.deepEqual(fixFor(check('GitHub App', 'fail', 'no GitHub App in /home/x/.config/harness: create one')), { kind: 'create-app' });
    assert.deepEqual(fixFor(check('GitHub App', 'fail', 'GET /repos/acme/shop/installation: 404 Not Found')), { kind: 'install-app' });
    assert.deepEqual(fixFor(check('GitHub App', 'warn', "can't write commit statuses, which the reviewers' verdicts need in Swarm")), { kind: 'app-statuses' });
    assert.deepEqual(fixFor(check('ruleset', 'fail', "doesn't require checks")), { kind: 'apply-rules' });
    assert.deepEqual(fixFor(check('.github/workflows/harness.yml', 'warn', 'differs from this version of the harness')), { kind: 'install-ci' });
    assert.equal(fixFor(check('Claude provider', 'fail', 'claude-sub is missing')), undefined, 'the doctor asks for the token itself');
  });

  it('reads the bundles the owner names, keeps core, and reports the unknown ones', () => {
    assert.deepEqual(parseBundles(''), { bundles: ['core'], unknown: [] });
    assert.deepEqual(parseBundles('node, python core'), { bundles: ['core', 'node', 'python'], unknown: [] });
    assert.deepEqual(parseBundles('node,ruby'), { bundles: ['core', 'node'], unknown: ['ruby'] });
  });
});
