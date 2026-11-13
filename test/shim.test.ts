import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, it } from 'node:test';
import type { AgentRequest } from '../src/daemon/channel.ts';
import { TOOLS, toolsManifest } from '../src/roles.ts';
import { sleep } from '../src/util.ts';
import { tempDir } from './helpers/toy-repo.ts';

const shim = join(import.meta.dirname, '..', 'shim', 'harness-mcp.mjs');

/** Starts the shim as Claude Code does, over stdio, and plays the daemon's side through the files. */
function startShim(tools: string) {
  const dir = tempDir('shim');
  writeFileSync(join(dir, 'tools.json'), tools);
  const child = spawn('node', [shim], { env: { ...process.env, HARNESS_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const responses = new Map<number, { resolve: (message: Record<string, any>) => void; reject: (error: Error) => void }>();
  // A shim that dies fails the calls it had, rather than leaving the test waiting.
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => {
    for (const { reject } of responses.values()) reject(new Error(`the shim exited with ${code}: ${stderr}`));
    resolve(code);
  }));
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as { id: number };
    responses.get(message.id)?.resolve(message);
    responses.delete(message.id);
  });
  let next = 1;
  const rpc = (method: string, params?: unknown) => new Promise<Record<string, any>>((resolve, reject) => {
    const id = next++;
    responses.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  /** The requests the shim has appended to its outbox so far. */
  const requests = () => (existsSync(join(dir, 'outbox.jsonl')) ? readFileSync(join(dir, 'outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as AgentRequest) : []);
  const stop = async () => {
    child.stdin.end();
    return exited;
  };
  return { dir, child, rpc, requests, stop, stderr: () => stderr };
}

async function until(ready: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !ready() && Date.now() < end; ) await sleep(20);
}

describe('the shim', () => {
  it("answers initialize and lists its tools.json, each with its input schema", async () => {
    const shimmed = startShim(toolsManifest('manager'));
    const init = await shimmed.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.deepEqual(init.result, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'harness', version: '1' } });
    const list = await shimmed.rpc('tools/list');
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), TOOLS.manager.map((t) => t.name));
    const manifest = JSON.parse(toolsManifest('manager')) as Array<{ name: string; description: string; inputSchema: object }>;
    assert.deepEqual(list.result.tools, manifest.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), 'no waitSec or onTimeout reaches Claude Code');
    assert.deepEqual((await shimmed.rpc('ping')).result, {});
    assert.match((await shimmed.rpc('resources/list')).error.message, /unknown method/);
    assert.equal(await shimmed.stop(), 0, 'it ends when Claude Code closes its input');
  });

  it('appends a call to the outbox and answers with its reply from the inbox, a reply written in pieces too', async () => {
    const shimmed = startShim(toolsManifest('developer'));
    const first = shimmed.rpc('tools/call', { name: 'web_read', arguments: { url: 'https://example.com/' } });
    const second = shimmed.rpc('tools/call', { name: 'ask_manager', arguments: { question: 'Which port?' } });
    await until(() => shimmed.requests().length === 2);
    const [read, asked] = shimmed.requests();
    assert.deepEqual([read!.v, read!.tool, read!.args], [1, 'web_read', { url: 'https://example.com/' }]);
    assert.match(read!.id, /^[A-Za-z0-9-]{1,64}$/);
    assert.deepEqual([asked!.tool, asked!.args], ['ask_manager', { question: 'Which port?' }]);
    // The replies come in the other order, one of them split mid-line and mid-character.
    const inbox = join(shimmed.dir, 'inbox.jsonl');
    const line = Buffer.from(`${JSON.stringify({ replyTo: asked!.id, ok: true, text: 'Use 8080 — said the Manager.' })}\n`);
    const cut = line.indexOf(Buffer.from('—')) + 1;
    appendFileSync(inbox, line.subarray(0, cut));
    await sleep(450);
    appendFileSync(inbox, line.subarray(cut));
    appendFileSync(inbox, `not json\n${JSON.stringify({ replyTo: read!.id, ok: false, text: 'refused: a private address' })}\n`);
    assert.deepEqual((await second).result, { content: [{ type: 'text', text: 'Use 8080 — said the Manager.' }], isError: false });
    assert.deepEqual((await first).result, { content: [{ type: 'text', text: 'refused: a private address' }], isError: true });
    assert.match((await shimmed.rpc('tools/call', { name: 'push_to_main', arguments: {} })).error.message, /unknown tool: push_to_main/);
    assert.equal(shimmed.requests().length, 2, 'an unknown tool reaches nothing');
    await shimmed.stop();
  });

  it('gives up after the wait, with the tool\'s own words', async () => {
    const shimmed = startShim(JSON.stringify([{ name: 'ask_manager', description: 'x', inputSchema: { type: 'object' }, waitSec: 0.3, onTimeout: 'No answer came.' }]));
    const result = await shimmed.rpc('tools/call', { name: 'ask_manager', arguments: { question: '?' } });
    assert.deepEqual(result.result, { content: [{ type: 'text', text: 'No answer came.' }], isError: true });
    await shimmed.stop();
  });

  it('lives through a message that is not an object, and a call whose outbox cannot be written', async () => {
    const shimmed = startShim(toolsManifest('developer'));
    shimmed.child.stdin.write('null\n42\n"text"\n[]\n');
    // A folder where the outbox should be: the append fails.
    mkdirSync(join(shimmed.dir, 'outbox.jsonl'));
    const failed = await shimmed.rpc('tools/call', { name: 'web_read', arguments: { url: 'https://example.com/' } });
    assert.equal(failed.result.isError, true);
    assert.match(failed.result.content[0].text, /^The harness could not take the call: /);
    assert.deepEqual((await shimmed.rpc('ping')).result, {}, shimmed.stderr());
    await shimmed.stop();
  });
});

describe("the shim's inbox mode, the Architect's hook", () => {
  const hook = (dir: string) => spawnSync('node', [shim, 'inbox'], { env: { ...process.env, HARNESS_DIR: dir }, encoding: 'utf8' });

  it('prints the notes left since the last prompt, once each, and nothing when there are none', () => {
    const dir = tempDir('shim-inbox');
    assert.deepEqual([hook(dir).status, hook(dir).stdout], [0, ''], 'no inbox yet');
    const file = join(dir, 'architect-inbox.jsonl');
    writeFileSync(file, `${JSON.stringify({ text: 'Plan P1 merged.' })}\n${JSON.stringify({ other: 1 })}\n`);
    assert.equal(hook(dir).stdout, '[harness] Messages for you since the last prompt:\n\nPlan P1 merged.\n');
    assert.equal(hook(dir).stdout, '');
    appendFileSync(file, `${JSON.stringify({ text: 'The owner answered.' })}\n`);
    assert.equal(hook(dir).stdout, '[harness] Messages for you since the last prompt:\n\nThe owner answered.\n');
    assert.equal(readFileSync(join(dir, 'architect-inbox.offset'), 'utf8'), String(readFileSync(file).length));
  });
});
