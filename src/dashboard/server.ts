import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Orchestrator } from '../daemon/orchestrator.ts';
import type { HarnessEvent } from '../state/events.ts';
import type { State } from '../state/state.ts';
import { Terminals, type Size } from './terminals.ts';

export interface DashboardOptions {
  orchestrator: Orchestrator;
  /** 0 picks a free port; the server's address tells which. */
  port: number;
  token: string;
  /** The built front end: `index.html` and its assets. */
  webRoot: string;
  terminals: Terminals;
}

/** What `GET /api/state` returns. */
export interface DashboardState {
  state: State;
  design: ReturnType<typeof designSummary>;
  progress: string[];
  /** Whether node-pty loaded: without it, there are no terminals in the dashboard. */
  terminals: boolean;
}

/** What the daemon types into an Architect's terminal so that its hook delivers the inbox. */
export const ARCHITECT_NUDGE = '[harness] New messages for you.';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/**
 * The owner's dashboard (§14.4): localhost only, a random token that becomes an HttpOnly
 * cookie, Host and Origin checks against DNS rebinding and cross-site requests, and a
 * content security policy. Server-sent events carry the live updates, WebSockets the
 * terminals, and POST requests the owner's actions.
 */
export function startDashboard({ orchestrator, port, token, webRoot, terminals }: DashboardOptions): Promise<Server> {
  let allowedHosts = new Set<string>();
  const clients = new Set<ServerResponse>();
  const transcripts = new Transcripts(orchestrator);

  const broadcast = (kind: string, data: unknown) => {
    for (const client of clients) client.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  orchestrator.events.on('event', (event: HarnessEvent) => broadcast('event', event));
  orchestrator.events.on('transcript', ({ agent, line }: { agent: string; line: string }) => {
    const item = transcripts.add(agent, line);
    if (item) broadcast('transcript', { agent, item });
  });
  orchestrator.events.on('architect-inbox', ({ sandbox }: { module: string; sandbox: string }) => {
    // At the terminal, the owner's own next prompt delivers it; typing there would mix with theirs.
    if (terminals.available && !terminals.watched(sandbox)) {
      terminals.prompt(sandbox, ARCHITECT_NUDGE).catch((error: Error) => orchestrator.log(`architect prompt: ${error.message}`));
    }
  });
  setInterval(() => clients.forEach((client) => client.write(': keepalive\n\n')), 20_000).unref();

  const authorized = (req: IncomingMessage, url: URL) => {
    const given = url.searchParams.get('token')
      ?? /(?:^|;\s*)harness_token=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1]
      ?? /^Bearer ([0-9a-f]+)$/.exec(req.headers.authorization ?? '')?.[1];
    return given !== undefined && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };
  const sameOrigin = (origin: string | undefined) => origin !== undefined && allowedHosts.has(origin.replace(/^http:\/\//, ''));

  // Nothing in a request may throw past this handler: an unhandled rejection would stop the daemon.
  const server = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 421, 'wrong host');
      if (req.method === 'POST' && req.headers.origin && !sameOrigin(req.headers.origin)) return send(res, 403, 'wrong origin');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!authorized(req, url)) return send(res, 401, 'open the URL the daemon printed, with its token');

      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
        res.writeHead(303, { 'set-cookie': `harness_token=${token}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
        return res.end();
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveFile(res, webRoot, url.pathname, [...allowedHosts]);

      const body = req.method === 'POST' ? (JSON.parse(await readBody(req)) as Record<string, unknown>) : {};
      const text = (key: string) => (typeof body[key] === 'string' && (body[key] as string).trim() !== '' ? (body[key] as string) : undefined);
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/state':
          return sendJson(res, {
            state: orchestrator.state,
            design: designSummary(orchestrator),
            progress: await progressTail(orchestrator),
            terminals: terminals.available,
          } satisfies DashboardState);
        case 'GET /api/events':
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write(': connected\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        case 'GET /api/log': {
          const limit = Math.min(Number(url.searchParams.get('limit')) || 300, 5000);
          return sendJson(res, orchestrator.store.readAll().slice(-limit));
        }
        case 'GET /api/transcript': {
          const items = transcripts.get(url.searchParams.get('agent') ?? '');
          return items ? sendJson(res, items) : send(res, 404, 'no such agent');
        }
        case 'GET /api/proposal': {
          // Only files the state names: a module that exists, and one of its versions.
          const module = orchestrator.state.modules[url.searchParams.get('module') ?? ''];
          const version = Number(url.searchParams.get('version'));
          if (!module || !module.proposals.some((p) => p.version === version)) return send(res, 404, 'no such proposal');
          const file = join(orchestrator.options.harnessDir, 'modules', module.module, 'proposals', `v${version}.md`);
          return send(res, existsSync(file) ? 200 : 404, existsSync(file) ? readFileSync(file, 'utf8') : 'not found');
        }
        case 'POST /api/pause':
          return sendJson(res, { done: orchestrator.pause() });
        case 'POST /api/resume':
          return sendJson(res, { done: orchestrator.resume() });
        case 'POST /api/retry':
          return sendJson(res, { done: typeof body.feature === 'string' && orchestrator.retry(body.feature, text('note')) });
        case 'POST /api/message':
          return sendJson(res, { done: text('text') !== undefined && orchestrator.messageManager(text('text')!) });
        case 'POST /api/architect': {
          // The owner writes to an Architect from the dashboard: typed into its terminal, as they would.
          const module = orchestrator.state.modules[typeof body.module === 'string' ? body.module : ''];
          if (!module || !text('text') || !terminals.available) return sendJson(res, { done: false });
          await terminals.prompt(module.architect.sandbox, text('text')!.replace(/\s*\n\s*/g, ' '));
          return sendJson(res, { done: true });
        }
        case 'POST /api/modules': {
          if (typeof body.id !== 'string') return sendJson(res, { done: false, error: 'a module needs an id' });
          const error = orchestrator.createModule(body.id, typeof body.title === 'string' ? body.title : '');
          return sendJson(res, error ? { done: false, error } : { done: true });
        }
        case 'POST /api/accept':
          return sendJson(res, { done: typeof body.module === 'string' && typeof body.version === 'number' && orchestrator.acceptProposal(body.module, body.version) });
        case 'POST /api/actions/done':
          return sendJson(res, { done: typeof body.module === 'string' && typeof body.action === 'string' && orchestrator.claimAction(body.module, body.action, text('note')) });
        case 'POST /api/answer':
          return sendJson(res, { done: typeof body.id === 'string' && text('text') !== undefined && orchestrator.answerOwnerRequest(body.id, text('text')!) });
      }
      send(res, 404, 'not found');
    } catch (error) {
      if (!res.headersSent) send(res, 500, (error as Error).message);
      else res.end();
    }
  });

  // Terminals: the same checks as any request, and a browser always sends its Origin.
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!allowedHosts.has(req.headers.host ?? '') || !sameOrigin(req.headers.origin) || !authorized(req, url) || url.pathname !== '/api/terminal') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => openTerminal(ws, url, orchestrator.state, terminals));
  });
  server.on('close', () => {
    terminals.closeAll();
    for (const client of clients) client.end();
  });

  // Several projects can run at once: if the port is taken, the next free one will do.
  const listen = (candidate: number, triesLeft: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && candidate !== 0 && triesLeft > 0) resolve(listen(candidate + 1, triesLeft - 1));
        else reject(error);
      };
      server.once('error', onError);
      server.listen(candidate, '127.0.0.1', () => {
        server.off('error', onError);
        const actual = (server.address() as AddressInfo).port;
        allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
        resolve(server);
      });
    });
  return listen(port, 20);
}

/**
 * A terminal over a WebSocket. `?module=<id>` is that module's Architect; `?sandbox=<name>`
 * opens a shell in a sandbox the harness runs. The browser sends `{"i": keys}` and
 * `{"cols", "rows"}`; the server sends the terminal's output as text.
 */
function openTerminal(ws: WebSocket, url: URL, state: State, terminals: Terminals): void {
  const size = (cols: unknown, rows: unknown): Size => ({ cols: clamp(Number(cols) || 80, 20, 400), rows: clamp(Number(rows) || 24, 5, 200) });
  const viewer = { send: (data: string) => ws.send(data), close: (reason: string) => ws.close(1000, reason.slice(0, 120)) };
  const initial = size(url.searchParams.get('cols'), url.searchParams.get('rows'));
  const module = url.searchParams.get('module');
  const sandbox = url.searchParams.get('sandbox');
  let terminal: ReturnType<Terminals['shell']>;
  try {
    if (!terminals.available) throw new Error('terminals need node-pty, which failed to install: use `harness attach`');
    if (module) {
      const architect = state.modules[module]?.architect.sandbox;
      if (!architect) throw new Error(`no Architect for ${module}`);
      terminal = terminals.attach(architect, viewer, initial);
    } else if (sandbox && runningSandboxes(state).includes(sandbox)) {
      terminal = terminals.shell(sandbox, viewer, initial);
    } else {
      throw new Error('no such sandbox');
    }
  } catch (error) {
    ws.close(1008, (error as Error).message.slice(0, 120));
    return;
  }
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(String(data)) as { i?: unknown; cols?: unknown; rows?: unknown };
      if (typeof message.i === 'string') terminal.input(message.i);
      else if (message.cols !== undefined) terminal.resize(size(message.cols, message.rows));
    } catch {
      // not ours: ignored
    }
  });
  ws.on('close', () => terminal.detach());
}

/** The sandboxes the owner may open a shell in: the agents' that are still there. */
export function runningSandboxes(state: State): string[] {
  const live = ['starting', 'running', 'collecting', 'checking', 'reviewing'];
  return [
    ...Object.values(state.modules).map((m) => m.architect.sandbox),
    ...Object.values(state.managers).filter((m) => m.status !== 'stopped').map((m) => m.sandbox),
    ...Object.values(state.features).flatMap((f) => f.attempts.filter((a) => live.includes(a.status)).map((a) => a.sandbox)),
  ];
}

/**
 * The agents' stream-json, for the live transcripts (§14.3). Recent lines stay in memory;
 * an attempt that ended, or a Manager's earlier session, is read back from its file.
 */
class Transcripts {
  private readonly live = new Map<string, unknown[]>();
  private readonly orchestrator: Orchestrator;

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  add(agent: string, line: string): unknown {
    const item = parseLine(line);
    if (item === undefined) return undefined;
    const items = this.live.get(agent) ?? [];
    items.push(item);
    if (items.length > 1000) items.shift();
    this.live.delete(agent);
    this.live.set(agent, items);
    // The oldest agents go first: only recent ones are watched live.
    if (this.live.size > 20) this.live.delete(this.live.keys().next().value!);
    return item;
  }

  get(agent: string): unknown[] | undefined {
    const live = this.live.get(agent);
    if (live) return live;
    const file = this.file(agent);
    if (!file || !existsSync(file)) return undefined;
    return readFileSync(file, 'utf8').split('\n').map(parseLine).filter((item) => item !== undefined).slice(-1000);
  }

  /** Only files the state names: the attempt of a known feature, or a module's Manager. */
  private file(agent: string): string | undefined {
    const harnessDir = this.orchestrator.options.harnessDir;
    const state = this.orchestrator.state;
    const developer = /^developer:([^/]+)\/([^/]+)\/([^/]+)\/a(\d+)$/.exec(agent);
    if (developer) {
      const [, module, plan, feature, n] = developer;
      const attempt = state.features[`${module}/${plan}/${feature}`]?.attempts.find((a) => a.n === Number(n));
      return attempt ? join(harnessDir, 'modules', module!, 'attempts', `${plan}-${feature}-a${n}`, 'stream.jsonl') : undefined;
    }
    const manager = /^manager:([^/]+)$/.exec(agent);
    const session = manager ? state.managers[manager[1]!]?.sessionId : undefined;
    return session ? join(harnessDir, 'modules', manager![1]!, 'manager', `transcript-${session}.jsonl`) : undefined;
  }
}

/** One stream-json line, with long strings cut: a tool's output can be megabytes. */
function parseLine(line: string): unknown {
  if (!line.trim()) return undefined;
  try {
    return clip(JSON.parse(line), 0);
  } catch {
    return undefined;
  }
}

function clip(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}… (${value.length - 4000} more characters)` : value;
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => clip(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, depth + 1)]));
}

/** The built front end. Only files under its folder, and `index.html` for anything else. */
function serveFile(res: ServerResponse, webRoot: string, path: string, hosts: string[]): void {
  const root = normalize(webRoot + sep);
  const candidate = normalize(join(webRoot, decodeURIComponent(path)));
  const file = candidate.startsWith(root) && existsSync(candidate) && extname(candidate) !== '' ? candidate : join(webRoot, 'index.html');
  if (!existsSync(file)) return send(res, 500, 'the dashboard is not built: run `npm run build`');
  const sockets = hosts.map((h) => `ws://${h}`).join(' ');
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    // xterm.js sets styles inline; scripts come only from the bundle.
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${sockets}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': file.endsWith('index.html') ? 'no-store' : 'max-age=31536000, immutable',
  });
  res.end(readFileSync(file));
}

function designSummary(orchestrator: Orchestrator) {
  const { config, modules } = orchestrator.design;
  return {
    project: config.project.name,
    repo: config.project.repo,
    maxAttempts: config.roles.developer.maxAttempts,
    attemptMinutes: config.roles.developer.attemptTimeoutMinutes,
    modules: modules.map((m) => ({
      id: m.id,
      plans: m.plans.map((p) => ({
        id: p.id,
        title: p.title,
        goal: p.goal,
        features: p.features.map((f) => ({ id: f.id, title: f.title, kind: f.kind, checks: f.checks.map((c) => ({ id: c.id, phase: c.phase, needs: c.needs })) })),
      })),
      actions: m.actions.map((a) => ({ id: a.id, kind: a.kind, title: a.title, when: a.when, blocks: a.blocks, instructions: a.instructions, verify: a.verify !== null })),
    })),
  };
}

/** The last lines of progress.txt on the most recently started plan branch. */
async function progressTail(orchestrator: Orchestrator): Promise<string[]> {
  const latest = Object.values(orchestrator.state.plans).at(-1);
  if (!latest) return [];
  const text = (await orchestrator.repo.show(`refs/heads/${latest.branch}`, 'progress.txt')) ?? '';
  return text.split('\n').filter(Boolean).slice(-10);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(body || '{}'));
    req.on('error', reject);
  });
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

function send(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}
