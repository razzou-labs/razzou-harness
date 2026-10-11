// The harness's MCP server inside a sandbox (proposal v2 §9.2). Claude Code starts it over
// stdio. It knows no tool by itself: `tools.json` lists them. Each call is appended to
// `outbox.jsonl`, which the daemon follows from outside, and the daemon appends its reply
// to `inbox.jsonl`. Nothing here opens a connection. Plain Node, no dependencies.
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';

const dir = process.env.HARNESS_DIR ?? '/sandbox/.harness';

// `harness-mcp.mjs inbox` is the Architect's UserPromptSubmit hook (§9.6): the notes the
// daemon left since the last prompt join this one. Whatever it prints, Claude Code adds.
if (process.argv[2] === 'inbox') {
  const file = join(dir, 'architect-inbox.jsonl');
  const offsetFile = join(dir, 'architect-inbox.offset');
  const offset = existsSync(offsetFile) ? Number(readFileSync(offsetFile, 'utf8')) || 0 : 0;
  const content = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  const end = content.lastIndexOf(0x0a) + 1;
  if (end > offset) {
    const notes = content.subarray(offset, end).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).text);
    process.stdout.write(`[harness] Messages for you since the last prompt:\n\n${notes.join('\n\n')}\n`);
    writeFileSync(offsetFile, String(end));
  }
  process.exit(0);
}

const tools = JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf8'));
const outbox = join(dir, 'outbox.jsonl');
const inbox = join(dir, 'inbox.jsonl');

/** Calls waiting for the daemon, by request id. */
const waiting = new Map();
const decoder = new StringDecoder('utf8');
let offset = 0;
let partial = '';

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

/** Reads what the daemon appended since last time, and hands each reply to its call. */
function readInbox() {
  if (!existsSync(inbox)) return;
  const fd = openSync(inbox, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return;
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    offset = size;
    partial += decoder.write(buffer);
  } finally {
    closeSync(fd);
  }
  const lines = partial.split('\n');
  partial = lines.pop() ?? '';
  for (const line of lines) {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = waiting.get(reply.replyTo);
    if (resolve) {
      waiting.delete(reply.replyTo);
      resolve(reply);
    }
  }
}

async function call(id, params) {
  const tool = tools.find((t) => t.name === params?.name);
  if (!tool) {
    send({ id, error: { code: -32602, message: `unknown tool: ${params?.name}` } });
    return;
  }
  const requestId = randomUUID();
  const reply = new Promise((resolve) => {
    waiting.set(requestId, resolve);
    setTimeout(() => {
      if (!waiting.delete(requestId)) return;
      const minutes = Math.round(tool.waitSec / 60);
      resolve({ ok: false, text: tool.onTimeout ?? `The harness did not reply within ${minutes || 1} minute(s). Try again later.` });
    }, tool.waitSec * 1000);
  });
  const request = { v: 1, id: requestId, ts: new Date().toISOString(), tool: tool.name, args: params.arguments ?? {} };
  appendFileSync(outbox, `${JSON.stringify(request)}\n`);
  const { ok, text } = await reply;
  send({ id, result: { content: [{ type: 'text', text: String(text) }], isError: ok !== true } });
}

setInterval(readInbox, 200);

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'harness', version: '1' },
      },
    });
  } else if (method === 'tools/list') {
    send({ id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  } else if (method === 'tools/call') {
    void call(id, params);
  } else if (method === 'ping') {
    send({ id, result: {} });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `unknown method: ${method}` } });
  }
});
lines.on('close', () => process.exit(0));
