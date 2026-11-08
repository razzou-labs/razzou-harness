import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeLock, directoryReader } from '../src/ci/harness-ci.ts';
import { granted, mainRuleset } from '../src/setup/doctor.ts';
import { init } from '../src/setup/init.ts';
import { recover } from '../src/setup/recover.ts';
import { awsProviderName, commitAndPush, fixFor, linkRepo, type SetupOptions } from '../src/setup/setup.ts';
import { run, runOk } from '../src/util.ts';
import { FakeForge } from './helpers/fake-forge.ts';
import { createToyRepo, tempDir } from './helpers/toy-repo.ts';

// Nothing here may read the owner's own App or git settings.
process.env.XDG_CONFIG_HOME = tempDir('xdg');
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

/** A repository on main with one commit, and by default a bare remote with it, as origin. */
async function project(withOrigin = true): Promise<{ dir: string; remote: string }> {
  const dir = tempDir('project');
  const remote = join(tempDir('remote'), 'repo.git');
  const git = (...args: string[]) => runOk('git', ['-C', dir, ...args]);
  await runOk('git', ['init', '--quiet', '--initial-branch=main', dir]);
  await git('config', 'user.name', 'owner');
  await git('config', 'user.email', 'owner@test.invalid');
  writeFileSync(join(dir, 'README.md'), '# shop\n');
  await git('add', 'README.md');
  await git('commit', '--quiet', '-m', 'start');
  if (withOrigin) {
    await runOk('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    await git('remote', 'add', 'origin', remote);
    await git('push', '--quiet', '-u', 'origin', 'main');
  }
  return { dir, remote };
}

/** The owner's answers, in order, and what the setup said. */
function owner(dir: string, answers: string[]) {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    said,
    asked,
    options: {
      projectDir: dir,
      say: (line: string) => void said.push(line),
      ask: async (question: string) => {
        asked.push(question);
        return answers.shift() ?? '';
      },
    },
  };
}

const head = async (dir: string, ref = 'HEAD') => (await runOk('git', ['-C', dir, 'rev-parse', ref])).trim();

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
    assert.deepEqual(fixFor(check('ruleset', 'fail', "doesn't apply to main")), { kind: 'apply-rules' });
    assert.equal(fixFor(check('ruleset', 'fail', 'applies to the default branch, master, not to main')), undefined, 'the default branch is the owner\'s to change');
    assert.deepEqual(fixFor(check('.github/workflows/harness.yml', 'warn', 'differs from this version of the harness')), { kind: 'install-ci' });
    assert.equal(fixFor(check('Claude provider', 'fail', 'claude-sub is missing')), undefined, 'the doctor asks for the token itself');
  });

  it('names the AWS provider after the repository, or else the folder and its path, so projects never share one', () => {
    assert.equal(awsProviderName('/home/x/shop', 'Acme/My.Shop'), 'aws-view-acme-my-shop');
    const a = awsProviderName('/home/x/work/shop');
    const b = awsProviderName('/home/x/play/shop');
    assert.match(a, /^aws-view-shop-[0-9a-f]{8}$/);
    assert.notEqual(a, b, 'two folders named shop');
    assert.equal(awsProviderName('/home/x/work/shop'), a, 'the same folder, the same name');
  });

  it('writes the files through a --dir that is a symlink to the repository', async () => {
    const { dir } = await project(false);
    const link = join(tempDir('links'), 'shop');
    symlinkSync(dir, link);
    const result = await init({ projectDir: link, packageDir: fileURLToPath(new URL('..', import.meta.url)), version: '0.2.0', owner: 'owner' });
    assert.ok(result.wrote.includes('harness/config.json'));
    assert.equal(JSON.parse(readFileSync(join(dir, 'harness', 'config.json'), 'utf8')).project.name, 'shop');
  });
});

describe('the setup links the project to GitHub on a later run', () => {
  let dir: string;
  const options = (): SetupOptions => ({
    projectDir: dir, packageDir: '', version: '0', say: () => {}, ask: async () => '', open: () => {}, interactive: () => 0, up: async () => {},
  });

  before(async () => {
    dir = (await project()).dir;
    await runOk('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://github.com/acme/shop.git']);
    mkdirSync(join(dir, 'harness'), { recursive: true });
    writeFileSync(join(dir, 'harness', 'config.json'), `${JSON.stringify({ harnessVersion: '0.2.0', project: { name: 'shop' }, network: { bundles: ['core'] } }, null, 2)}\n`);
  });

  it('adds project.repo and project.bot once the remote and the App are there, with the lock that follows', async () => {
    const config = join(process.env.XDG_CONFIG_HOME!, 'harness');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'app.json'), JSON.stringify({ appId: 7, slug: 'acme-harness' }));
    assert.deepEqual(await linkRepo(options(), async () => {}), ['harness/config.json', 'harness/lock.json']);
    const written = JSON.parse(readFileSync(join(dir, 'harness', 'config.json'), 'utf8'));
    assert.deepEqual(written.project, { name: 'shop', repo: 'acme/shop', bot: 'acme-harness[bot]' });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'harness', 'lock.json'), 'utf8')), await computeLock(directoryReader(dir)));
    assert.deepEqual(await linkRepo(options(), async () => {}), [], 'linked already');
  });
});

describe('the setup commits only its files, and pushes only main', () => {
  it('commits the files it wrote, and nothing the owner had staged, then pushes main', async () => {
    const { dir, remote } = await project();
    mkdirSync(join(dir, 'harness'), { recursive: true });
    writeFileSync(join(dir, 'harness', 'config.json'), '{}\n');
    writeFileSync(join(dir, 'notes.txt'), 'work in progress\n');
    await runOk('git', ['-C', dir, 'add', 'notes.txt']);
    const o = owner(dir, ['y']);
    await commitAndPush(o.options, ['harness/config.json', '.harness/setup.json']);
    assert.deepEqual((await runOk('git', ['-C', dir, 'show', '--name-only', '--format=%s', 'HEAD'])).trim().split('\n'), ['Set up razzou-harness', '', 'harness/config.json']);
    assert.equal((await runOk('git', ['-C', dir, 'diff', '--cached', '--name-only'])).trim(), 'notes.txt', 'still staged, not committed');
    assert.equal(await head(remote, 'main'), await head(dir));
    assert.equal((await runOk('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'main@{upstream}'])).trim(), 'origin/main');
    assert.match(o.said.at(-1)!, /committed and pushed to main/);
  });

  it('on another branch, commits without pushing, and says how to finish', async () => {
    const { dir, remote } = await project();
    const before = await head(remote, 'main');
    await runOk('git', ['-C', dir, 'switch', '--quiet', '-c', 'feature']);
    writeFileSync(join(dir, 'init.sh'), '#!/usr/bin/env bash\n');
    const o = owner(dir, ['y']);
    await commitAndPush(o.options, ['init.sh']);
    assert.match(o.asked[0]!, /^Commit 1 file on feature, as you\? The setup pushes only main/);
    assert.equal(await head(remote, 'main'), before, 'nothing pushed');
    assert.equal((await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'feature@{upstream}'])).code === 0, false, 'no upstream for the branch');
    assert.match(o.said.at(-1)!, /^committed on feature \([0-9a-f]+\), not pushed: the setup pushes only main\. Bring the commit to main/);
  });

  it('offers the push again while the setup commit is on main but not on origin', async () => {
    const { dir, remote } = await project(false);
    await runOk('git', ['-C', dir, 'remote', 'add', 'origin', '/nonexistent/repo.git']);
    writeFileSync(join(dir, 'init.sh'), '#!/usr/bin/env bash\n');
    const first = owner(dir, ['y']);
    await commitAndPush(first.options, ['init.sh']);
    assert.match(first.said.at(-1)!, /^committed, but the push was refused/);

    await runOk('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    await runOk('git', ['-C', dir, 'remote', 'set-url', 'origin', remote]);
    const declined = owner(dir, ['n']);
    await commitAndPush(declined.options, []);
    assert.match(declined.asked[0]!, /^main has the setup's commit, and origin's main doesn't yet\. Push main/);
    const again = owner(dir, ['y']);
    await commitAndPush(again.options, []);
    assert.equal(again.asked.length, 1, 'offered again');
    assert.equal(await head(remote, 'main'), await head(dir));
    const done = owner(dir, []);
    await commitAndPush(done.options, []);
    assert.deepEqual(done.asked, [], 'pushed: nothing to offer');
  });
});

describe("the doctor's GitHub checks", () => {
  it("reads what the App's installation grants, not what the App asks for", () => {
    const lines = ['App: acme-harness (owner acme)', 'Permissions: contents=write, statuses=read, workflows=write', 'App permissions: contents=write, statuses=write'];
    assert.equal(granted(lines, 'statuses'), 'read', 'not accepted on the installation yet');
    assert.equal(granted(lines, 'workflows'), 'write');
    assert.equal(granted(lines, 'checks'), undefined);
    assert.equal(granted(['Permissions: commit_statuses=write'], 'statuses'), undefined);
  });

  describe('the ruleset on main', () => {
    const path = process.env.PATH;
    const ruleset = join(tempDir('gh'), 'ruleset.json');
    const conditions = (include: string[], defaultBranch?: string) => {
      writeFileSync(ruleset, JSON.stringify({ enforcement: 'active', conditions: { ref_name: { include, exclude: [] } }, rules: [] }));
      if (defaultBranch === undefined) delete process.env.FAKE_DEFAULT_BRANCH;
      else process.env.FAKE_DEFAULT_BRANCH = defaultBranch;
    };

    before(() => {
      // gh, as the owner's login would answer for acme/shop.
      const bin = tempDir('bin');
      writeFileSync(join(bin, 'gh'), [
        '#!/bin/bash',
        'case "$*" in',
        `  "api repos/acme/shop/rulesets") echo '[{"id":7,"name":"harness: main"}]' ;;`,
        `  "api repos/acme/shop/rulesets/7") cat ${ruleset} ;;`,
        '  "api repos/acme/shop --jq .default_branch") [ -n "$FAKE_DEFAULT_BRANCH" ] && echo "$FAKE_DEFAULT_BRANCH" ;;',
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'));
      chmodSync(join(bin, 'gh'), 0o755);
      process.env.PATH = `${bin}:${path}`;
    });
    after(() => {
      process.env.PATH = path;
    });

    it('applies to main as the default branch only when main is the default branch', async () => {
      conditions(['~DEFAULT_BRANCH'], 'main');
      assert.equal((await mainRuleset('acme/shop'))?.offMain, undefined);
      conditions(['~DEFAULT_BRANCH'], 'master');
      assert.equal((await mainRuleset('acme/shop'))?.offMain, 'applies to the default branch, master, not to main');
    });

    it('applies to main by name, and not to other branches', async () => {
      conditions(['refs/heads/main']);
      const named = await mainRuleset('acme/shop');
      assert.ok(named, 'read without asking for the default branch');
      assert.equal(named.offMain, undefined);
      conditions(['refs/heads/release']);
      assert.equal((await mainRuleset('acme/shop'))?.offMain, "doesn't apply to main");
    });
  });
});

describe('harness recover', () => {
  it("reads main from GitHub, which the owner's checkout may be behind, and says what it can't bring back", async () => {
    const projectDir = tempDir('project');
    await createToyRepo(projectDir);
    const fake = await FakeForge.create(projectDir);
    // Merged on GitHub, not pulled: both features of demo/P1 are on main there only.
    const clone = tempDir('clone');
    await runOk('git', ['clone', '--quiet', fake.remote, clone]);
    writeFileSync(join(clone, 'progress.txt'), ['F01', 'F02'].map((f) => `2026-11-07T00:00:00.000Z feature.accepted demo/P1/${f} attempt=1 "done"\n`).join(''));
    await runOk('git', ['-C', clone, 'add', 'progress.txt']);
    await runOk('git', ['-C', clone, '-c', 'user.name=owner', '-c', 'user.email=owner@test.invalid', 'commit', '--quiet', '-m', 'merged on GitHub']);
    await runOk('git', ['-C', clone, 'push', '--quiet', 'origin', 'main']);

    const notes = await recover({ projectDir, harnessDir: join(projectDir, '.harness'), forge: fake });
    assert.equal(notes[0], 'demo/P1: completed');
    assert.match(notes.at(-1)!, /^Nor what you set: the mode is Manual again .*the hours of your time .*the owner tasks you marked done are pending again/);
  });
});
