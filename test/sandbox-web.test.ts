import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { readResult, readReview } from '../src/agents/claude-code.ts';
import { AgentChannel } from '../src/daemon/channel.ts';
import type { Orchestrator } from '../src/daemon/orchestrator.ts';
import { handleRequest } from '../src/daemon/requests.ts';
import { htmlToText, neverRead, onHostNetwork, webRead } from '../src/daemon/web-read.ts';
import { parseLine, runningSandboxes, startDashboard } from '../src/dashboard/server.ts';
import { ARCHITECT_NUDGE, QUIET_MS, Terminals, type Pty } from '../src/dashboard/terminals.ts';
import { MAX_FOLLOWED_LINE, OpenShellDriver, splitLines } from '../src/sandbox/openshell.ts';
import { buildPolicy } from '../src/sandbox/policy.ts';
import type { State } from '../src/state/state.ts';
import { sleep } from '../src/util.ts';
import { LocalDriver } from './helpers/local-driver.ts';
import { tempDir } from './helpers/toy-repo.ts';

const servers: Server[] = [];
after(() => servers.forEach((server) => server.close()));

/** Waits until `ready()` holds, five seconds at most. */
async function until(ready: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !ready() && Date.now() < end; ) await sleep(20);
}

describe('web_read', () => {
  it("refuses this machine's addresses and its networks, IPv4 and IPv6", () => {
    const interfaces = [
      { address: '192.0.2.10', netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:01', internal: false, cidr: '192.0.2.10/24' },
      { address: '2001:db8:1:2::abcd', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '02:00:00:00:00:01', internal: false, cidr: '2001:db8:1:2::abcd/64', scopeid: 0 },
      { address: '198.51.100.7', netmask: '255.255.255.255', family: 'IPv4', mac: '02:00:00:00:00:02', internal: false, cidr: null },
      { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' },
    ] as NetworkInterfaceInfo[];
    // Its own addresses, its router at <prefix>::1, its neighbours, even written as IPv4-mapped IPv6.
    for (const ip of ['192.0.2.10', '192.0.2.1', '::ffff:192.0.2.200', '2001:db8:1:2::abcd', '2001:db8:1:2::1', '198.51.100.7']) {
      assert.equal(onHostNetwork(ip, interfaces), true, ip);
    }
    for (const ip of ['192.0.3.1', '2001:db8:1:3::1', '198.51.100.8', '127.0.0.2', 'not an ip']) assert.equal(onHostNetwork(ip, interfaces), false, ip);
  });

  it('refuses a URL over 2,000 characters, and records every read with its URLs clipped, a failed one too', async () => {
    const recorded: Array<{ type: string; payload: { url: string; finalUrl?: string; ok: boolean; bytes: number } }> = [];
    let fails = false;
    const o = {
      webRead: async (url: string) => {
        if (fails) throw new Error('the socket broke');
        return { ok: true, text: 'page', finalUrl: `${url}/final`, status: 200, bytes: 4 };
      },
      record: (event: (typeof recorded)[number]) => recorded.push(event),
    } as unknown as Orchestrator;
    const agent = { role: 'developer' as const, sandbox: 'dev-x' };
    const call = (url: string) => handleRequest(o, agent, { v: 1, id: 'r-1', tool: 'web_read', args: { url } });
    const long = `https://example.com/${'x'.repeat(2000)}`;
    assert.match((await call(long))!.text, /Invalid arguments/);
    assert.equal(recorded.length, 0, 'a refused URL is not fetched, nor recorded');
    const url = `https://example.com/${'x'.repeat(1900)}`;
    assert.deepEqual(await call(url), { ok: true, text: 'page' });
    assert.ok(recorded[0]!.payload.url.length <= 300 && recorded[0]!.payload.finalUrl!.length <= 300);
    fails = true;
    await assert.rejects(call(url), /the socket broke/);
    assert.deepEqual([recorded.length, recorded[1]!.type, recorded[1]!.payload.ok, recorded[1]!.payload.bytes], [2, 'WEB_READ', false, 0]);
  });

  it('never reads chat apps', () => {
    for (const host of ['claude.ai', 'chatgpt.com', 'www.chatgpt.com']) assert.equal(neverRead(host), true, host);
  });

  describe('against a local server', () => {
    let base = '';
    const options = { allowAddress: (ip: string) => ip === '127.0.0.1', allowPort: () => true };
    // 64 gzip members of 1 MiB of zeros: 67 kB that decode to 64 MiB.
    const member = gzipSync(Buffer.alloc(1 << 20));

    it('starts', async () => {
      const server = createServer((req, res) => {
        const slow = /^\/slow\/(\d+)$/.exec(req.url ?? '');
        if (slow) {
          setTimeout(() => res.writeHead(302, { location: `/slow/${Number(slow[1]) + 1}` }).end(), 150);
        } else if (req.url === '/cut' || req.url === '/stall') {
          // The first half of a compressed page, then the connection drops, or nothing more comes.
          const page = gzipSync(Buffer.from('<p>words</p>'.repeat(10_000)));
          res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': page.length });
          res.write(page.subarray(0, page.length >> 1), () => {
            if (req.url === '/cut') setTimeout(() => res.destroy(), 50);
          });
        } else if (req.url === '/bomb') {
          res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
          res.end(Buffer.concat(Array.from({ length: 64 }, () => member)));
        } else {
          res.writeHead(404).end();
        }
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    it('stops decoding at the size limit, so a small body that expands stays small', async () => {
      const result = await webRead(`${base}/bomb`, { ...options, maxBytes: 100_000 });
      assert.equal(result.bytes, 100_000);
      assert.match(result.text, /larger than the size limit/);
      // The decoder stopped too: nothing more of its 64 MiB piles up after the call.
      const before = process.memoryUsage().arrayBuffers;
      await sleep(300);
      assert.ok(process.memoryUsage().arrayBuffers - before < 16 * 1024 * 1024);
    });

    it('answers when a compressed page is cut short, or stalls, within the deadline', async () => {
      for (const path of ['/cut', '/stall']) {
        const started = Date.now();
        const result = await webRead(`${base}${path}`, { ...options, timeoutMs: 1500 });
        assert.equal(result.ok, false, path);
        assert.match(result.text, path === '/cut' ? /^failed: / : /^failed: no complete answer within 1.5 s$/, path);
        assert.ok(Date.now() - started < 2500, path);
      }
    });

    it('gives the whole read one deadline, redirects included', async () => {
      const started = Date.now();
      const result = await webRead(`${base}/slow/0`, { ...options, timeoutMs: 400 });
      assert.equal(result.ok, false);
      assert.equal(result.text, 'failed: no complete answer within 0.4 s');
      assert.ok(Date.now() - started < 1000);
    });
  });

  it('turns HTML into text in linear time, whatever is left unclosed', () => {
    for (const unit of ['<!--', '<title>', '<script>', '<style x>', '<a href="x">', '<a href=x>', '<', '<h1 ', '<p>']) {
      const html = unit.repeat(Math.ceil(2_000_000 / unit.length));
      const started = performance.now();
      htmlToText(html);
      assert.ok(performance.now() - started < 1000, unit);
    }
  });

  it('reads an ordinary page as it did', () => {
    const page = [
      '<!doctype html><html><head><title>A &amp; B</title><style>p { color: red }</style></head>',
      '<body><!-- nav --><nav><a href="/">Home</a> | <a href="#top">Top</a></nav>',
      '<h2 id="x">Install <small>v2</small></h2>',
      '<p>Run <code>npm i</code>, then see <a href="docs/next.html"><b>the next</b> page</a> or <a href="mailto:a@example.com">mail</a>.<br>Done.</p>',
      '<table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>',
      '<script type="module">document.write("<p>hidden</p>")</script><ul><li>one<li>two &lt;3</ul></body></html>',
    ].join('\n');
    assert.equal(
      htmlToText(page, new URL('https://example.com/guide/')),
      '# A & B\n\nHome (https://example.com/) | Top\n\n## Install v2\n\nRun\nnpm i, then see the next page (https://example.com/guide/docs/next.html) or mail.\nDone.\n\nName | Value |\na | 1 |\n\n- one\n- two <3',
    );
  });

  it('ends a comment at --!> too, as browsers do', () => {
    assert.equal(htmlToText('<p>one <!-- a --!>two</p><p>three</p><!-- b -->'), 'one two\nthree');
  });
});

describe('the sandbox policy', () => {
  it("keeps a bundle's rule for a host the project also lists", () => {
    const policy = buildPolicy({ bundles: ['core'], extraHosts: ['github.com', 'docs.example.com', 'docs.example.com'] }) as {
      network_policies: Record<string, { endpoints: Array<{ host: string }> }>;
    };
    const hosts = (name: string) => policy.network_policies[name]!.endpoints.map((e) => e.host);
    assert.equal(hosts('git_fetch').filter((host) => host === 'github.com').length, 1);
    assert.equal(hosts('read_only_web').filter((host) => host === 'github.com').length, 0);
    assert.equal(hosts('read_only_web').filter((host) => host === 'docs.example.com').length, 1);
  });
});

describe('the agent channel', () => {
  it('tells an agent its request is too large, when its id can be read', async () => {
    const driver = new LocalDriver(tempDir('channel-big'));
    await driver.create({ name: 'dev-big', image: 'x', providers: [], env: {} });
    const harness = join(driver.rootOf('dev-big'), '.harness');
    const outbox = join(harness, 'outbox.jsonl');
    const inbox = join(harness, 'inbox.jsonl');
    const invalid: string[] = [];
    const channel = new AgentChannel({
      driver, sandbox: 'dev-big', outbox, inbox, repliedFile: join(tempDir('replied-big'), 'replied.txt'),
      onRequest: () => {}, onInvalid: (reason) => invalid.push(reason),
    });
    channel.start();
    const url = `https://example.com/${'x'.repeat(70 * 1024)}`;
    appendFileSync(outbox, `${JSON.stringify({ v: 1, id: 'big-1', tool: 'web_read', args: { url } })}\n`);
    appendFileSync(outbox, `${JSON.stringify({ v: 1, tool: 'web_read', args: { url } })}\n`);
    await until(() => invalid.length === 2 && existsSync(inbox) && readFileSync(inbox, 'utf8').includes('big-1'));
    channel.stop();
    const replies = readFileSync(inbox, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { replyTo: string; ok: boolean; text: string });
    assert.deepEqual(replies.map((r) => [r.replyTo, r.ok]), [['big-1', false]]);
    assert.match(replies[0]!.text, /^the request is too large: \d+ characters, where the limit is 65536$/);
    assert.equal(invalid.length, 2);
    await driver.removeAll();
  });

  it("handles a sandbox's requests two at a time, and refuses those over sixty a minute", async () => {
    const driver = new LocalDriver(tempDir('channel-rate'));
    await driver.create({ name: 'dev-rate', image: 'x', providers: [], env: {} });
    const harness = join(driver.rootOf('dev-rate'), '.harness');
    const outbox = join(harness, 'outbox.jsonl');
    const inbox = join(harness, 'inbox.jsonl');
    const handled: string[] = [];
    const pending: Array<() => void> = [];
    let running = 0;
    let most = 0;
    const channel = new AgentChannel({
      driver, sandbox: 'dev-rate', outbox, inbox, repliedFile: join(tempDir('replied-rate'), 'replied.txt'),
      onRequest: (request) => {
        handled.push(request.id);
        most = Math.max(most, ++running);
        return new Promise<void>((resolve) => pending.push(() => { running--; resolve(); }));
      },
      onInvalid: () => {},
    });
    channel.start();
    const lines = Array.from({ length: 62 }, (_, i) => `${JSON.stringify({ v: 1, id: `r-${i}`, tool: 'web_read', args: { url: 'https://example.com/' } })}\n`);
    appendFileSync(outbox, lines.join(''));
    await until(() => existsSync(inbox) && readFileSync(inbox, 'utf8').trim().split('\n').length === 2);
    assert.deepEqual(handled, ['r-0', 'r-1'], 'two at a time');
    for (let done = 0; done < 60; done++) {
      await until(() => pending.length > 0);
      pending.shift()!();
    }
    await until(() => handled.length === 60);
    channel.stop();
    assert.equal(handled.length, 60);
    assert.equal(most, 2);
    const replies = readFileSync(inbox, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { replyTo: string; ok: boolean; text: string });
    assert.deepEqual(replies.map((r) => [r.replyTo, r.ok]), [['r-60', false], ['r-61', false]]);
    assert.match(replies[0]!.text, /^too many requests: at most 60 a minute/);
    await driver.removeAll();
  });
});

describe("the Architect's inbox hook", () => {
  const shim = join(import.meta.dirname, '..', 'shim', 'harness-mcp.mjs');

  it('skips a torn line, and waits only for an unfinished last one', () => {
    const dir = tempDir('inbox');
    const file = join(dir, 'architect-inbox.jsonl');
    writeFileSync(file, `${JSON.stringify({ text: 'first' })}\n{"text": "torn\n${JSON.stringify({ text: 'second' })}\n{"text":`);
    const hook = () => spawnSync('node', [shim, 'inbox'], { env: { ...process.env, HARNESS_DIR: dir }, encoding: 'utf8' });
    const first = hook();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, '[harness] Messages for you since the last prompt:\n\nfirst\n\nsecond\n');
    assert.equal(hook().stdout, '');
    appendFileSync(file, ' "third"}\n');
    assert.equal(hook().stdout, '[harness] Messages for you since the last prompt:\n\nthird\n');
  });
});

describe('the OpenShell driver', () => {
  /** Stands in for `openshell sandbox exec … -- <command>`: runs the command here, whatever the options. */
  function fakeOpenShell(): string {
    const bin = join(tempDir('openshell'), 'openshell');
    writeFileSync(bin, '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
    return bin;
  }

  it('splits lines, and drops one over the limit up to its newline', () => {
    const lines: string[] = [];
    let dropped = 0;
    const write = splitLines((line) => lines.push(line), () => dropped++);
    write('a\nb');
    write('c\n');
    write(`${'z'.repeat(MAX_FOLLOWED_LINE)}\n`);
    write('x'.repeat(MAX_FOLLOWED_LINE));
    write('x'.repeat(10));
    write('yy\nd\n');
    assert.deepEqual(lines.map((line) => line.slice(0, 3)), ['a', 'bc', 'zzz', 'd']);
    assert.equal(dropped, 1);
  });

  it('says a sandbox is missing only when the gateway says so, and throws when the gateway does not answer', async () => {
    const answering = (script: string) => {
      const bin = join(tempDir('openshell'), 'openshell');
      writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      return new OpenShellDriver(bin);
    };
    // OpenShell 0.1.7's two answers with exit code 1.
    const notFound = answering(`echo "Error:   × code: 'Some requested entity was not found', message: \\"sandbox not found\\"" >&2; exit 1`);
    assert.equal(await notFound.status('arc-1'), 'missing');
    const unreachable = answering('echo "Error:   × connect error: transport error" >&2; exit 1');
    await assert.rejects(unreachable.status('arc-1'), /openshell sandbox get arc-1 failed: Error: {3}× connect error: transport error/);
    assert.equal(await answering(`echo '{"phase":"Ready"}'`).status('arc-1'), 'ready');
    assert.equal(await answering(`echo '{"phase":"Stopped"}'`).status('arc-1'), 'stopped');
    assert.equal(await answering(`echo '{"phase":"Provisioning"}'`).status('arc-1'), 'other');
    // A delete that fails never throws: the sweep deletes what it left.
    await unreachable.remove('arc-1');
  });

  it('kills an exec whose CLI hangs past its timeout', async () => {
    const driver = new OpenShellDriver(fakeOpenShell());
    assert.deepEqual(await driver.exec('sb', 'echo hi', { timeoutSec: 5 }), { code: 0, stdout: 'hi\n', stderr: '' });
    const started = Date.now();
    const hung = await driver.exec('sb', 'sleep 5', { timeoutSec: 0.2 });
    assert.deepEqual(hung, { code: 124, stdout: '', stderr: 'openshell sandbox exec did not end within 0.4 s, and was killed' });
    assert.ok(Date.now() - started < 3000);
  });

  it('fails a command that prints more than the 64 MB kept, and says so', async () => {
    const result = await new OpenShellDriver(fakeOpenShell()).exec('sb', 'head -c 70000000 /dev/zero; echo done', { timeoutSec: 30 });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /more than 64 MB: its output went over the limit and was cut/);
    await assert.rejects(new OpenShellDriver(join(tempDir('no-openshell'), 'openshell')).exec('sb', 'true'), /ENOENT/, 'an openshell that does not start is still an error');
  });

  it('follows a file again when its exec ends, from the line after the last one read', async () => {
    const file = join(tempDir('follow'), 'outbox.jsonl');
    writeFileSync(file, `one\n${'x'.repeat(MAX_FOLLOWED_LINE + 10)}\ntwo\n`);
    const lines: string[] = [];
    const follower = new OpenShellDriver(fakeOpenShell()).follow('sb', file, 1, (line) => lines.push(line));
    await until(() => lines.length === 2);
    // The exec ends unasked, as when the gateway restarts.
    spawnSync('pkill', ['-f', file]);
    appendFileSync(file, 'three\n');
    await until(() => lines.length === 3);
    follower.stop();
    await follower.done;
    assert.deepEqual(lines, ['one', 'two', 'three']);
  });

  it('lives with an openshell that does not start, until stopped', async () => {
    const follower = new OpenShellDriver(join(tempDir('no-openshell'), 'openshell')).follow('sb', '/nowhere', 1, () => {});
    await sleep(50);
    follower.stop();
    await follower.done;
  });

  it('uploads a file Git ignores, as every file the harness keeps under .harness is', async () => {
    // OpenShell 0.1.7's upload: inside a Git work tree, .gitignore applies unless --no-git-ignore.
    const bin = join(tempDir('openshell'), 'openshell');
    writeFileSync(bin, [
      '#!/bin/sh',
      'filter=1',
      'shift 2',
      'for arg do',
      '  shift',
      '  if [ "$arg" = --no-git-ignore ]; then filter=0; else set -- "$@" "$arg"; fi',
      'done',
      'if [ $filter = 1 ] && git -C "$(dirname "$2")" check-ignore -q "$2"; then',
      '  echo "Git filtering selected no files for $2; upload stopped." >&2',
      '  exit 1',
      'fi',
      'mkdir -p "$3" && cp "$2" "$3"',
      '',
    ].join('\n'), { mode: 0o755 });
    const project = tempDir('ignored');
    spawnSync('git', ['init', '--quiet', project]);
    writeFileSync(join(project, '.gitignore'), '.harness/\n');
    mkdirSync(join(project, '.harness'));
    writeFileSync(join(project, '.harness', 'main.bundle'), 'history');
    const sandbox = tempDir('sandbox');
    await new OpenShellDriver(bin).upload('sb', join(project, '.harness', 'main.bundle'), join(sandbox, 'harness'));
    assert.equal(readFileSync(join(sandbox, 'harness', 'main.bundle'), 'utf8'), 'history');
  });
});

describe('usage limits', () => {
  const result = (text: string, isError = true) => JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, result: text });

  it("knows Claude Code's words for a subscription that ran out, old and new", () => {
    for (const text of [
      "You've hit your 5-hour limit · resets 3pm",
      "You've hit your weekly limit · resets Nov 10, 9am",
      "You've reached your Opus limit",
      "You're out of usage credits",
      "You're out of extra usage · resets 3pm",
      'Your org is out of usage · contact your admin',
      'Claude AI usage limit reached|1767225600',
    ]) {
      assert.equal(readResult(result(text), 1).outcome, 'usage_limit', text);
      assert.equal(readReview(result(text), 1).outcome, 'usage_limit', text);
    }
    // Only an error result says so.
    assert.equal(readResult(result("You've hit your 5-hour limit", false), 0).outcome, 'no_report');
  });
});

describe('the dashboard', () => {
  const token = 'ab'.repeat(16);
  const code = 'cd'.repeat(16);

  async function dashboard(loginCode?: string, extra: Record<string, unknown> = {}, terminals = new Terminals(undefined)) {
    const webRoot = tempDir('web');
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>harness</title>');
    const logged: string[] = [];
    const state = { modules: {}, managers: {}, features: {}, plans: {}, ownerRequests: {}, actions: {} };
    const orchestrator = { events: new EventEmitter(), state, log: (line: string) => logged.push(line), ...extra } as unknown as Orchestrator;
    const server = await startDashboard({ orchestrator, port: 0, token, loginCode, webRoot, terminals });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const get = (path: string, cookie?: string) =>
      new Promise<{ status: number; cookie: string }>((resolve, reject) => {
        const headers = { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) };
        request({ host: '127.0.0.1', port, path, headers }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie'] ?? '') });
        }).on('error', reject).end();
      });
    const call = (method: string, path: string, body?: unknown) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
        const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const post = async (path: string, body: unknown) => JSON.parse((await call('POST', path, body)).text) as { done: boolean; error?: string };
    return { port, get, call, post, logged, orchestrator, state };
  }

  /** Writes a raw request to the dashboard and gives back what came before the socket closed. */
  const raw = (port: number, text: string) =>
    new Promise<string>((resolve) => {
      let answer = '';
      const socket = connect(port, '127.0.0.1', () => socket.write(text));
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (answer += chunk));
      socket.on('error', () => {});
      // A daemon that died on the request never answers: the test fails rather than waits.
      socket.setTimeout(2000, () => socket.destroy());
      socket.on('close', () => resolve(answer));
    });

  it('lives through an upgrade whose path is no URL', async () => {
    const { port, get } = await dashboard();
    const host = `127.0.0.1:${port}`;
    await raw(port, `GET // HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    assert.match(await raw(port, `GET /x HTTP/1.1\r\nHost: elsewhere\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`), /^$|403/);
    assert.equal((await get(`/?token=${token}`)).status, 303, 'the daemon still answers');
  });

  it("lives through a message over a terminal's limit, and takes a long paste", async () => {
    const written: string[] = [];
    const pty: Pty = { onData: () => {}, onExit: () => {}, write: (data) => written.push(data), resize: () => {}, kill: () => {} };
    const { port, get, state } = await dashboard(undefined, {}, new Terminals(() => pty));
    (state.modules as Record<string, unknown>).shop = { module: 'shop', architect: { sandbox: 'arc-1' } };
    const open = () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal?module=shop`, { headers: { authorization: `Bearer ${token}` }, origin: `http://127.0.0.1:${port}` });
      return new Promise<WebSocket>((resolve, reject) => ws.on('open', () => resolve(ws)).on('error', reject));
    };
    const paste = await open();
    paste.send(JSON.stringify({ i: 'p'.repeat(600 * 1024) }));
    await until(() => written.some((data) => data.length === 600 * 1024));
    assert.ok(written.some((data) => data.length === 600 * 1024), 'the paste reached the terminal');
    paste.close();
    const big = await open();
    const closed = new Promise<number>((resolve) => big.on('close', (code) => resolve(code)));
    big.send('x'.repeat(2 * 1024 * 1024));
    assert.equal(await Promise.race([closed, sleep(3000).then(() => 0)]), 1009);
    assert.equal((await get(`/?token=${token}`)).status, 303, 'the daemon still answers');
  });

  it('tells the open pages when the design on main changed', async () => {
    const { port, orchestrator } = await dashboard();
    const received = await new Promise<string>((resolve, reject) => {
      const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };
      const req = request({ host: '127.0.0.1', port, path: '/api/events', headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes(': connected')) orchestrator.events.emit('design');
          if (text.includes('event: design')) {
            req.destroy();
            resolve(text);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('no design event')));
      req.end();
    });
    assert.match(received, /event: design\ndata: \{\}/);
  });

  it('keeps a transcript line nested deeper than its limit, and one too heavy, as markers', async () => {
    const { orchestrator, call } = await dashboard();
    const deep = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    orchestrator.events.emit('transcript', { agent: 'manager:shop', line: deep });
    orchestrator.events.emit('transcript', { agent: 'manager:shop', line: JSON.stringify({ type: 'user', parts: Array.from({ length: 40 }, () => 'y'.repeat(3000)) }) });
    const items = JSON.parse((await call('GET', '/api/transcript?agent=manager:shop')).text) as unknown[];
    assert.equal(items.length, 2);
    assert.match(JSON.stringify(items[0]), /nested too deep to show/);
    assert.deepEqual(items[1], { type: 'clipped', text: `an item of ${JSON.stringify({ type: 'user', parts: Array.from({ length: 40 }, () => 'y'.repeat(3000)) }).length} characters, too large to show` });
    assert.ok(JSON.stringify(parseLine(deep)).length < 200);
  });

  it('names its cookie for its port, and logs in once with the code of the link it opened', async () => {
    const { port, get } = await dashboard(code);
    const login = await get(`/?code=${code}`);
    assert.equal(login.status, 303);
    assert.match(login.cookie, new RegExp(`^harness_token_${port}=${token}; HttpOnly; SameSite=Strict`));
    assert.equal((await get(`/?code=${code}`)).status, 401, 'the code works once');
    assert.equal((await get(`/?code=${'ef'.repeat(16)}`)).status, 401);
    assert.equal((await get(`/?token=${token}`)).status, 303, 'the printed link still works');
    assert.equal((await get('/', `harness_token_${port}=${token}`)).status, 200);
    assert.equal((await get('/', `harness_token=${token}; harness_token_${port + 1}=${token}`)).status, 401, "other dashboards' cookies are theirs");
  });

  it('refuses the code two minutes after the start', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const { get } = await dashboard(code);
    t.mock.timers.tick(121_000);
    assert.equal((await get(`/?code=${code}`)).status, 401);
  });

  it('hears `harness attach` come and go, for a module of the project only', async () => {
    const terminals = new Terminals(undefined);
    const { post, state } = await dashboard(undefined, {}, terminals);
    (state.modules as Record<string, unknown>).shop = { module: 'shop', architect: { sandbox: 'arc-1' } };
    assert.deepEqual(await post('/api/attach', { module: 'shop', attached: true }), { done: true });
    assert.equal(terminals.watched('arc-1'), true);
    assert.deepEqual(await post('/api/attach', { module: 'shop', attached: false }), { done: true });
    assert.equal(terminals.watched('arc-1'), false);
    assert.equal((await post('/api/attach', { module: '__proto__', attached: true })).done, false);
    assert.equal((await post('/api/attach', { module: 'shop' })).done, false);
  });

  it("opens a shell in a reviewer's sandbox while its review runs", () => {
    const reviews = [['rev-old', 'reported'], ['rev-now', 'running'], ['rev-next', 'starting'], ['rev-bad', 'failed']].map(([sandbox, status]) => ({ sandbox, status }));
    const state = { modules: {}, managers: {}, features: {}, plans: { 'shop/P1': { reviews }, 'shop/P2': {} } } as unknown as State;
    assert.deepEqual(runningSandboxes(state), ['rev-now', 'rev-next']);
  });

  it('lifts a pause that only waits to look again, and nothing else, with "Look again now"', async () => {
    let lifted = 0;
    let resumed = 0;
    const { post } = await dashboard(undefined, { lookAgain: () => ++lifted === 1, resume: () => ++resumed > 0 });
    assert.deepEqual(await post('/api/look-again', {}), { done: true });
    assert.deepEqual(await post('/api/look-again', {}), { done: false, error: 'no pause waits to look again' });
    assert.equal(resumed, 0);
  });

  it("looks up the ids a request names as the state's own: `__proto__` is no question", async () => {
    let answered = 0;
    const { post } = await dashboard(undefined, { answerOwnerRequest: () => ++answered > 0 });
    for (const id of ['__proto__', 'constructor', 'toString']) assert.deepEqual(await post('/api/answer', { id, text: 'yes' }), { done: false, error: 'no such question' }, id);
    assert.equal((await post('/api/retry', { feature: '__proto__' })).error, 'no such feature');
    assert.equal(answered, 0);
  });

  it('gives at least one line of the log, whatever the limit', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const { call } = await dashboard(undefined, { store: { readAll: () => lines } });
    for (const limit of ['-3', '0.2', '2']) {
      const answer = JSON.parse((await call('GET', `/api/log?limit=${limit}`)).text) as unknown[];
      assert.deepEqual(answer, limit === '2' ? lines.slice(-2) : lines.slice(-1), limit);
    }
  });

  it('refuses a body too large, and still answers', async () => {
    const { call, post } = await dashboard(undefined, { messageManager: () => true });
    const answer = await call('POST', '/api/message', { text: 'x'.repeat(200 * 1024) });
    assert.equal(answer.status, 500);
    assert.equal(answer.text, 'body too large');
    assert.deepEqual(await post('/api/message', { text: 'hello' }), { done: true });
  });

  it('says a left-over sandbox is deleted only once the gateway no longer lists it', async () => {
    let status = 'ready';
    const removed: string[] = [];
    const driver = {
      list: async () => [{ name: 'dev-old', phase: 'Ready', labels: { 'harness.project': 'toy' } }],
      remove: async (name: string) => void removed.push(name),
      status: async () => status,
    };
    const { post } = await dashboard(undefined, { driver, checking: new Map(), design: { config: { project: { name: 'toy' } } } });
    assert.deepEqual(await post('/api/sandboxes/remove', { name: 'dev-old' }), { done: false, error: 'the gateway still lists it after the delete: ready' });
    status = 'missing';
    assert.deepEqual(await post('/api/sandboxes/remove', { name: 'dev-old' }), { done: true });
    assert.deepEqual(removed, ['dev-old', 'dev-old']);
  });

  it('logs when the login code is used, and when another try comes', async () => {
    const { get, logged } = await dashboard(code);
    await get(`/?code=${code}`);
    await get(`/?code=${code}`);
    assert.deepEqual(logged, ['dashboard: the login code of the opened link was used', 'dashboard: a login with a code was refused (the code was used already)']);
  });

  it("opens no shell in an attempt's sandbox once its checks started, as the daemon deleted it", () => {
    const attempts = ['running', 'collecting', 'checking', 'reviewing'].map((status) => ({ sandbox: `dev-${status}`, status }));
    const state = { modules: {}, managers: {}, features: { 'shop/P1/F1': { attempts } }, plans: {} } as unknown as State;
    assert.deepEqual(runningSandboxes(state), ['dev-running', 'dev-collecting']);
  });

  it("serves a finished reviewer's transcript from its review's folder", async () => {
    const harnessDir = tempDir('harness');
    const { call, state } = await dashboard(undefined, { options: { harnessDir } });
    const head = '0123456789abcdef';
    (state.plans as Record<string, unknown>)['shop/P1'] = { module: 'shop', plan: 'P1', reviews: [{ role: 'security', head, status: 'reported' }] };
    const dir = join(harnessDir, 'modules', 'shop', 'reviews', 'P1-security-01234567');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'brief.md'), '# Review P1');
    writeFileSync(join(dir, 'stream.jsonl'), `${JSON.stringify({ type: 'result', subtype: 'success' })}\n`);
    const answer = await call('GET', '/api/transcript?agent=security:01234567');
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(JSON.parse(answer.text), [{ type: 'prompt', text: '# Review P1' }, { type: 'result', subtype: 'success' }]);
  });
});

describe('terminals', () => {
  it('live with a terminal whose program already exited', async () => {
    const pty: Pty = {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {
        throw new Error('ioctl(2) failed, EBADF');
      },
      kill: () => {},
    };
    const view = new Terminals(() => pty).attach('arc-1', { send: () => {}, close: () => {} }, { cols: 80, rows: 24 });
    view.resize({ cols: 100, rows: 30 });
    // The resize after 100 ms, from a timer, too.
    await sleep(150);
    view.detach();
  });

  describe("an Architect's nudge", () => {
    /** Terminals whose connections answer at once, and what was typed into them; `failing` connections fail to start. */
    const recording = () => {
      const typed: string[] = [];
      const control = { failing: false };
      const terminals = new Terminals(() => {
        if (control.failing) throw new Error('openshell did not start');
        let output = (_data: string) => {};
        setTimeout(() => output('$ '), 1);
        return { onData: (listener) => (output = listener), onExit: () => {}, write: (data) => typed.push(data), resize: () => {}, kill: () => {} };
      });
      const nudges = () => typed.filter((data) => data === ARCHITECT_NUDGE).length;
      return { terminals, typed, control, nudges };
    };
    const viewer = { send: () => {}, close: () => {} };

    it('is typed at once when nobody is at the terminal, and once only', async () => {
      const { terminals, nudges } = recording();
      await terminals.announce('arc-1');
      await terminals.announceDue();
      assert.equal(nudges(), 1);
    });

    it('waits, while a viewer is there, until nobody typed for five minutes', async () => {
      const { terminals, nudges } = recording();
      const view = terminals.attach('arc-1', viewer, { cols: 80, rows: 24 });
      view.input('ls');
      await terminals.announce('arc-1');
      await terminals.announceDue(Date.now() + QUIET_MS - 10_000);
      assert.equal(nudges(), 0, 'the owner typed four minutes ago');
      await terminals.announceDue(Date.now() + QUIET_MS + 1000);
      assert.equal(nudges(), 1);
      view.detach();
    });

    it("counts `harness attach` as somebody at the terminal, until it leaves", async () => {
      const { terminals, nudges } = recording();
      terminals.attachOutside('arc-1', true);
      assert.equal(terminals.watched('arc-1'), true);
      await terminals.announce('arc-1');
      assert.equal(nudges(), 0);
      terminals.attachOutside('arc-1', false);
      assert.equal(terminals.watched('arc-1'), false);
      await terminals.announceDue();
      assert.equal(nudges(), 1);
    });

    it('stays due when typing it fails, and is typed on the next try', async () => {
      const { terminals, control, nudges } = recording();
      control.failing = true;
      await assert.rejects(terminals.announce('arc-1'), /arc-1: openshell did not start/);
      control.failing = false;
      await terminals.announceDue();
      assert.equal(nudges(), 1);
    });
  });
});
