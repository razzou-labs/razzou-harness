import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, describe, it } from 'node:test';
import { claudeCode, managerSettings, userMessage } from '../src/agents/claude-code.ts';
import { AgentChannel, type AgentRequest } from '../src/daemon/channel.ts';
import { htmlToText, isPublicAddress, neverRead, webRead } from '../src/daemon/web-read.ts';
import { toolsManifest } from '../src/roles.ts';
import { sleep } from '../src/util.ts';
import { LocalDriver } from './helpers/local-driver.ts';
import { tempDir } from './helpers/toy-repo.ts';

const shim = join(import.meta.dirname, '..', 'shim', 'harness-mcp.mjs');

describe('mcp shim', () => {
  /** Starts the shim as Claude Code would, and plays the daemon's side through the files. */
  function startShim(tools: string) {
    const dir = tempDir('shim');
    writeFileSync(join(dir, 'tools.json'), tools);
    const child = spawn('node', [shim], { env: { ...process.env, HARNESS_DIR: dir }, stdio: ['pipe', 'pipe', 'inherit'] });
    const responses = new Map<number, (message: Record<string, unknown>) => void>();
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as { id: number };
      responses.get(message.id)?.(message);
    });
    let next = 1;
    const rpc = (method: string, params?: unknown) => new Promise<Record<string, any>>((resolve) => {
      const id = next++;
      responses.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    return { dir, child, rpc };
  }

  it('lists the tools and relays a call through the outbox and the inbox', async () => {
    const { dir, child, rpc } = startShim(toolsManifest('developer'));
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      assert.equal(init.result.protocolVersion, '2025-06-18');
      assert.deepEqual(init.result.capabilities, { tools: {} });
      const list = await rpc('tools/list');
      assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['ask_manager', 'web_read']);
      assert.equal(list.result.tools[0].inputSchema.type, 'object');

      const answer = rpc('tools/call', { name: 'ask_manager', arguments: { question: 'Which port?' } });
      let request: AgentRequest | undefined;
      for (let i = 0; i < 50 && !request; i++) {
        await sleep(50);
        if (existsSync(join(dir, 'outbox.jsonl'))) request = JSON.parse(readFileSync(join(dir, 'outbox.jsonl'), 'utf8')) as AgentRequest;
      }
      assert.deepEqual([request?.tool, request?.args], ['ask_manager', { question: 'Which port?' }]);
      appendFileSync(join(dir, 'inbox.jsonl'), `${JSON.stringify({ replyTo: 'someone-else', ok: true, text: 'not for you' })}\n`);
      appendFileSync(join(dir, 'inbox.jsonl'), `${JSON.stringify({ replyTo: request!.id, ok: true, text: 'Use 8080.' })}\n`);
      const result = await answer;
      assert.deepEqual(result.result, { content: [{ type: 'text', text: 'Use 8080.' }], isError: false });

      const unknown = await rpc('tools/call', { name: 'push_to_main', arguments: {} });
      assert.match(unknown.error.message, /unknown tool/);
    } finally {
      child.kill();
    }
  });

  it('gives up after the wait, with the tool\'s own words', async () => {
    const tools = JSON.stringify([{ name: 'ask_manager', description: 'x', inputSchema: { type: 'object' }, waitSec: 0.3, onTimeout: 'No answer came.' }]);
    const { child, rpc } = startShim(tools);
    try {
      const result = await rpc('tools/call', { name: 'ask_manager', arguments: { question: '?' } });
      assert.deepEqual(result.result, { content: [{ type: 'text', text: 'No answer came.' }], isError: true });
    } finally {
      child.kill();
    }
  });
});

describe('agent channel', () => {
  it('hands each request over once, refuses invalid ones, and remembers what it answered', async () => {
    const driver = new LocalDriver(tempDir('channel'));
    await driver.create({ name: 'dev-test', image: 'x', providers: [], env: {} });
    const harness = join(driver.rootOf('dev-test'), '.harness');
    mkdirSync(harness, { recursive: true });
    const outbox = join(harness, 'outbox.jsonl');
    const inbox = join(harness, 'inbox.jsonl');
    const repliedFile = join(tempDir('replied'), 'replied.txt');
    const seen: string[] = [];
    const invalid: string[] = [];
    const open = () => {
      const channel = new AgentChannel({
        driver, sandbox: 'dev-test', outbox, inbox, repliedFile,
        onRequest: (r) => { seen.push(r.id); void channel.reply(r.id, true, `done ${r.tool}`); },
        onInvalid: (reason) => invalid.push(reason),
      });
      channel.start();
      return channel;
    };

    const first = open();
    appendFileSync(outbox, `${JSON.stringify({ v: 1, id: 'a1', tool: 'get_state', args: {} })}\n`);
    appendFileSync(outbox, `${JSON.stringify({ v: 1, id: 'a1', tool: 'get_state', args: {} })}\n`);
    appendFileSync(outbox, 'not json\n');
    appendFileSync(outbox, `${JSON.stringify({ v: 1, id: 'b2', tool: 'get_state', args: 'no' })}\n`);
    for (let i = 0; i < 50 && !readFileSync(inbox, { flag: 'a+', encoding: 'utf8' }).includes('"b2"'); i++) await sleep(50);
    first.stop();

    assert.deepEqual(seen, ['a1']);
    assert.equal(invalid.length, 2);
    const replies = readFileSync(inbox, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { replyTo: string; ok: boolean; text: string });
    assert.deepEqual(replies.map((r) => [r.replyTo, r.ok]), [['a1', true], ['b2', false]]);
    assert.match(replies[1]!.text, /invalid request/);

    // After a restart the outbox is read again from the start, and nothing is answered twice.
    const second = open();
    appendFileSync(outbox, `${JSON.stringify({ v: 1, id: 'c3', tool: 'get_state', args: {} })}\n`);
    for (let i = 0; i < 50 && !seen.includes('c3'); i++) await sleep(50);
    second.stop();
    assert.deepEqual(seen, ['a1', 'c3']);
    await driver.removeAll();
  });
});

describe('web_read', () => {
  it('knows public addresses from private ones', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.101.102.103', '0.0.0.0', '::1', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'not an ip']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });

  it('never reads paste sites, tunnels, request catchers or buckets', () => {
    for (const host of ['webhook.site', 'abc.ngrok-free.app', 'pastebin.com', 'my-bucket.s3.amazonaws.com', 'discord.com']) assert.equal(neverRead(host), true, host);
    for (const host of ['docs.python.org', 'nodejs.org', 'developer.hashicorp.com']) assert.equal(neverRead(host), false, host);
  });

  it('refuses private addresses, other schemes and credentials before connecting', async () => {
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost/', 'ftp://example.com/', 'https://user:pass@example.com/', 'http://example.com:8080/']) {
      const result = await webRead(url);
      assert.equal(result.ok, false, url);
      assert.match(result.text, /^refused: /, url);
    }
  });

  describe('against a local server', () => {
    let server: Server;
    let base = '';
    const pages: Record<string, (res: import('node:http').ServerResponse) => void> = {
      '/doc': (res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Guide</title><script>alert(1)</script></head><body><h1>Install</h1><p>Run <code>npm i</code> &amp; see <a href="/more">more</a>.</p></body></html>');
      },
      '/hop': (res) => { res.writeHead(302, { location: '/doc' }); res.end(); },
      '/escape': (res) => { res.writeHead(302, { location: 'http://10.0.0.1/admin' }); res.end(); },
      '/big': (res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(5000)); },
      '/image': (res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(10)); },
    };
    const options = { allowAddress: (ip: string) => ip === '127.0.0.1', allowPort: () => true };

    it('starts', async () => {
      server = createServer((req, res) => (pages[req.url ?? ''] ?? ((r) => { r.writeHead(404); r.end(); }))(res));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => server?.close());

    it('returns a page as text, after a redirect, with its links', async () => {
      const result = await webRead(`${base}/hop`, options);
      assert.equal(result.ok, true);
      assert.equal(result.finalUrl, `${base}/doc`);
      assert.match(result.text, /^URL: .*\/doc\nStatus: 200\n\n# Guide\n\n# Install\n/);
      assert.match(result.text, /Run\s+npm i\s*& see more \(http:\/\/127\.0\.0\.1:\d+\/more\)\./);
      assert.doesNotMatch(result.text, /alert/);
    });

    it('checks every redirect again', async () => {
      const result = await webRead(`${base}/escape`, options);
      assert.equal(result.ok, false);
      assert.match(result.text, /refused: 10\.0\.0\.1 is not a public address/);
    });

    it('stops at the size limit, and refuses what is not text', async () => {
      const big = await webRead(`${base}/big`, { ...options, maxBytes: 1000 });
      assert.match(big.text, /larger than the size limit/);
      const image = await webRead(`${base}/image`, options);
      assert.equal(image.ok, false);
      assert.match(image.text, /image\/png, not text/);
    });
  });

  it('turns HTML into readable text', () => {
    assert.equal(htmlToText('<ul><li>one</li><li>two &lt;b&gt;</li></ul><!-- x --><p>a&nbsp;b &#x263A;</p>'), '- one\n- two <b>\na b ☺');
  });
});

describe('manager launch', () => {
  it('runs restricted, with the git rules and the harness tools only', () => {
    const script = claudeCode.launchManager({
      workDir: '/w', promptFile: '/h/manager.md', mcpConfigFile: '/h/mcp.json', settingsFile: '/h/settings.json',
      inputFile: '/h/manager/launch-2/in.jsonl', outputFile: '/h/manager/out.jsonl', stderrFile: '/h/e', exitFile: '/h/x',
      pidFile: '/h/p', tailPidFile: '/h/t', sessionId: '0f6c', model: 'claude-opus-5-5', effort: 'high',
    });
    // The body runs under `bash -c '…'`, so its own quotes are escaped once more.
    const body = script.replaceAll(`'\\''`, `'`);
    for (const flag of ['--restricted', "'--permission-mode' 'dontAsk'", "'--tools' 'Read,Grep,Glob,Bash'", '--strict-mcp-config', '--replay-user-messages', "'--input-format' 'stream-json'"]) {
      assert.ok(body.includes(flag), flag);
    }
    assert.match(body, /ls "\$HOME"\/\.claude\/projects\/\*\/0f6c\.jsonl > \/dev\/null 2>&1 && echo --resume \|\| echo --session-id/);
    assert.match(body, /exec tail -n \+1 -s 0\.2 -F/);
    assert.deepEqual(JSON.parse(managerSettings()).permissions.allow, ['Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'mcp__harness']);
    assert.deepEqual(JSON.parse(userMessage('hi')), { type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null });
  });

  it('describes every tool with a schema the shim can serve', () => {
    for (const tool of JSON.parse(toolsManifest('manager')) as Array<{ name: string; inputSchema: Record<string, unknown> }>) {
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.equal(tool.inputSchema.$schema, undefined, tool.name);
    }
  });
});
