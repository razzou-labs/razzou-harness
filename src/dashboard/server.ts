import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Orchestrator, SetupStatus } from '../daemon/orchestrator.ts';
import type { HarnessEvent } from '../state/events.ts';
import type { SubscriptionUsage } from '../anthropic/usage.ts';
import type { ModuleOwnerTime } from '../design/owner-time.ts';
import type { State } from '../state/state.ts';
import { readDockerUsage, type UsageReading } from '../sandbox/docker.ts';
import { removeLeftOver, sandboxDenials, sandboxOverview, sharedReading } from '../daemon/sandboxes.ts';
import { configView } from './config-view.ts';
import { designView, type DesignView } from './design-view.ts';
import { Terminals, type Size } from './terminals.ts';
import { tokensByRole, type RoleTokens } from './tokens.ts';

export interface DashboardOptions {
  orchestrator: Orchestrator;
  /** 0 picks a free port; the server's address tells which. */
  port: number;
  token: string;
  /**
   * For the link the daemon opens in a browser, whose command line other users can read:
   * `/?code=` logs in once, in the first two minutes. `/?token=` always does.
   */
  loginCode?: string;
  /** The built front end: `index.html` and its assets. */
  webRoot: string;
  terminals: Terminals;
  /** What the sandboxes use of the machine; by default, Docker's reading. Tests replace it. */
  usage?: () => Promise<UsageReading>;
}

/** What `GET /api/state` returns. */
export interface DashboardState {
  state: State;
  design: DesignView;
  /** The owner's time in each module: its hours, if they set any, and what its design plans and used of them. */
  ownerTime: ModuleOwnerTime[];
  /** The subscription's usage, as an agent's model call last reported it: for the meters, and the Swarm ceiling (v3 §4.3). */
  usage?: { at: string; usage: SubscriptionUsage };
  /** In Swarm, where its setup stands, for the note that lists what is left to do (v4 §6). */
  setup?: SetupStatus;
  progress: string[];
  /** Whether node-pty loaded: without it, there are no terminals in the dashboard. */
  terminals: boolean;
  /** Claude's tokens by role, with what the prompt cache served (0.5.1). */
  tokens: RoleTokens[];
}

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
export function startDashboard({ orchestrator, port, token, loginCode, webRoot, terminals, usage = () => readDockerUsage() }: DashboardOptions): Promise<Server> {
  let allowedHosts = new Set<string>();
  // Named for the port: cookies don't tell ports apart, and every project's dashboard has its own token.
  let cookie = 'harness_token';
  let code = loginCode;
  const started = Date.now();
  const clients = new Set<ServerResponse>();
  const transcripts = new Transcripts(orchestrator);
  const sandboxUsage = sharedReading(usage);

  const broadcast = (kind: string, data: unknown) => {
    for (const client of clients) client.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  orchestrator.events.on('event', (event: HarnessEvent) => broadcast('event', event));
  // An agent reported the subscription's usage: the pages fetch the state again.
  orchestrator.events.on('usage', () => broadcast('usage', {}));
  // The design read from main changed, which records no event: the pages fetch the state again.
  orchestrator.events.on('design', () => broadcast('design', {}));
  // It runs inside a follower's data handler, on lines an agent writes: nothing may throw out of it.
  orchestrator.events.on('transcript', ({ agent, line }: { agent: string; line: string }) => {
    try {
      for (const item of transcripts.add(agent, line)) broadcast('transcript', { agent, item });
    } catch (error) {
      orchestrator.log(`transcript of ${agent}: ${(error as Error).message}`);
    }
  });
  // A note for an Architect stays unannounced until the nudge is typed in its terminal: at
  // once when nobody is there, after five quiet minutes when somebody is, tried each minute.
  // Without node-pty nothing can be typed: the owner's next prompt there delivers it.
  const announce = (attempt: Promise<void>) => attempt.catch((error: Error) => orchestrator.log(`architect prompt: ${error.message}`));
  orchestrator.events.on('architect-inbox', ({ sandbox }: { module: string; sandbox: string }) => {
    if (terminals.available) void announce(terminals.announce(sandbox));
  });
  setInterval(() => terminals.available && void announce(terminals.announceDue()), 60_000).unref();
  setInterval(() => clients.forEach((client) => client.write(': keepalive\n\n')), 20_000).unref();

  const authorized = (req: IncomingMessage, url: URL) =>
    matches(
      url.searchParams.get('token')
        ?? new RegExp(`(?:^|;\\s*)${cookie}=([0-9a-f]+)`).exec(req.headers.cookie ?? '')?.[1]
        ?? /^Bearer ([0-9a-f]+)$/.exec(req.headers.authorization ?? '')?.[1],
      token,
    );
  const login = (res: ServerResponse) => {
    res.writeHead(303, { 'set-cookie': `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
    res.end();
  };
  const sameOrigin = (origin: string | undefined) => origin !== undefined && allowedHosts.has(origin.replace(/^http:\/\//, ''));

  // Nothing in a request may throw past this handler: an unhandled rejection would stop the daemon.
  const server = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 421, 'wrong host');
      if (req.method === 'POST' && req.headers.origin && !sameOrigin(req.headers.origin)) return send(res, 403, 'wrong origin');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('code')) {
        // The code sits on a command line other users can read: the log says when it is used, and when another try comes.
        if (code !== undefined && Date.now() - started < 120_000 && matches(url.searchParams.get('code'), code)) {
          code = undefined;
          orchestrator.log('dashboard: the login code of the opened link was used');
          return login(res);
        }
        orchestrator.log(`dashboard: a login with a code was refused (${code === undefined ? 'the code was used already' : Date.now() - started >= 120_000 ? 'the code expired' : 'not the code'})`);
      }
      if (!authorized(req, url)) return send(res, 401, 'open the URL the daemon printed, with its token');

      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) return login(res);
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveFile(res, webRoot, url.pathname, [...allowedHosts]);

      const body = req.method === 'POST' ? (JSON.parse(await readBody(req)) as Record<string, unknown>) : {};
      const text = (key: string) => (typeof body[key] === 'string' && (body[key] as string).trim() !== '' ? (body[key] as string) : undefined);
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/state':
          return sendJson(res, {
            state: orchestrator.state,
            design: designView(orchestrator.design),
            ownerTime: await orchestrator.ownerTimes(),
            ...(orchestrator.usage ? { usage: orchestrator.usage } : {}),
            ...(orchestrator.state.mode === 'swarm' ? { setup: await orchestrator.setupStatus() } : {}),
            progress: await progressTail(orchestrator),
            terminals: terminals.available,
            tokens: tokensByRole(orchestrator.state, orchestrator.options.harnessDir),
          } satisfies DashboardState);
        case 'GET /api/events':
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write(': connected\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        case 'GET /api/log': {
          // At least one line: slice(-0) and a negative limit would give the whole log.
          const limit = clamp(Number(url.searchParams.get('limit')) || 300, 1, 5000);
          return sendJson(res, orchestrator.store.readAll().slice(-limit));
        }
        case 'GET /api/transcript': {
          const items = transcripts.get(url.searchParams.get('agent') ?? '');
          return items ? sendJson(res, items) : send(res, 404, 'no such agent');
        }
        case 'GET /api/sandboxes':
          return sendJson(res, await sandboxOverview(orchestrator));
        case 'GET /api/sandboxes/usage':
          return sendJson(res, await sandboxUsage());
        case 'GET /api/sandboxes/denials': {
          const denials = await sandboxDenials(orchestrator, url.searchParams.get('name') ?? '');
          return denials ? sendJson(res, denials) : send(res, 404, "not one of this project's sandboxes");
        }
        case 'GET /api/proposal': {
          // Only files the state names: a module that exists, and one of its versions.
          const module = own(orchestrator.state.modules, url.searchParams.get('module'));
          const version = Number(url.searchParams.get('version'));
          if (!module || !module.proposals.some((p) => p.version === version)) return send(res, 404, 'no such proposal');
          const file = join(orchestrator.options.harnessDir, 'modules', module.module, 'proposals', `v${version}.md`);
          return send(res, existsSync(file) ? 200 : 404, existsSync(file) ? readFileSync(file, 'utf8') : 'not found');
        }
        case 'POST /api/sandboxes/remove': {
          if (typeof body.name !== 'string') return sendJson(res, { done: false, error: 'which sandbox?' });
          const removed = await removeLeftOver(orchestrator, body.name);
          if (!removed.done) return sendJson(res, removed);
          // The driver's delete never throws: only the gateway's answer afterwards says it is gone.
          const status = await orchestrator.driver.status(body.name).catch((error: Error) => `unknown (${error.message})`);
          return sendJson(res, status === 'missing' ? { done: true } : { done: false, error: `the gateway still lists it after the delete: ${status}` });
        }
        case 'POST /api/sandboxes/limits': {
          // A number caps, null lifts the cap.
          const cap = (key: string) => (body[key] === null ? null : typeof body[key] === 'number' ? body[key] : undefined);
          const cpu = cap('cpu');
          const memoryGiB = cap('memoryGiB');
          if (cpu === undefined || memoryGiB === undefined) return sendJson(res, { done: false, error: 'cpu and memoryGiB: a number, or null for no cap' });
          const error = orchestrator.setSandboxLimits({ cpu, memoryGiB });
          return sendJson(res, error ? { done: false, error } : { done: true });
        }
        case 'POST /api/pause':
          return sendJson(res, orchestrator.pause() ? { done: true } : { done: false, error: 'the pipeline is paused already' });
        case 'POST /api/resume':
          return sendJson(res, orchestrator.resume() ? { done: true } : { done: false, error: 'the pipeline is not paused' });
        case 'POST /api/look-again':
          // A pause that only waits to look again is lifted as the daemon lifts it: none of what a resume sets off happens.
          return sendJson(res, orchestrator.lookAgain() ? { done: true } : { done: false, error: 'no pause waits to look again' });
        case 'POST /api/infra-merge':
          return sendJson(res, body.by === 'daemon' || body.by === 'ceiling' ? (orchestrator.setInfraMerge(body.by) ? { done: true } : { done: false, error: 'it is so already' }) : { done: false, error: 'by is daemon or ceiling' });
        case 'POST /api/fix-merge':
          // Who merges a Fix PR in Swarm: the daemon, under the plans' policy, or the owner.
          return sendJson(res, body.by === 'daemon' || body.by === 'owner' ? (orchestrator.setFixMerge(body.by) ? { done: true } : { done: false, error: 'it is so already' }) : { done: false, error: 'by is daemon or owner' });
        case 'POST /api/reviews': {
          // A reviewer's switch: every plan's pull request, infrastructure plans' only (the cost reviewer's), or none.
          const { role, scope } = body;
          if ((role !== 'security' && role !== 'cost') || (scope !== 'on' && scope !== 'infra' && scope !== 'off')) {
            return sendJson(res, { done: false, error: 'role is security or cost; scope is on, infra or off' });
          }
          const error = orchestrator.setReviews(role, scope);
          return sendJson(res, error ? { done: false, error } : { done: true });
        }
        case 'POST /api/mode':
          // The dashboard's switch and `harness mode` alike: the mode, and main's rules with the owner's gh.
          return sendJson(res, body.mode === 'manual' || body.mode === 'swarm' ? await orchestrator.switchMode(body.mode) : { done: false, error: 'the mode is manual or swarm' });
        case 'GET /api/config':
          return sendJson(res, await configView(orchestrator));
        case 'POST /api/owner-hours': {
          // The hours of the owner's time for one module: a positive number sets them, null clears them.
          if (typeof body.module !== 'string' || !(body.hours === null || typeof body.hours === 'number')) return sendJson(res, { done: false, error: 'a module, and its hours or null' });
          const error = orchestrator.setOwnerHours(body.module, body.hours);
          return sendJson(res, error ? { done: false, error } : { done: true });
        }
        case 'POST /api/order': {
          // The owner asks a Manager in which order to handle the cards of Needs you.
          const error = orchestrator.requestOrder();
          return sendJson(res, error ? { done: false, error } : { done: true });
        }
        // The ids a request names are looked up as the state's own keys only: `__proto__` is none.
        case 'POST /api/retry': {
          const feature = own(orchestrator.state.features, body.feature);
          if (!feature) return sendJson(res, { done: false, error: 'no such feature' });
          if (feature.status !== 'escalated') return sendJson(res, { done: false, error: 'the feature is not escalated' });
          return sendJson(res, orchestrator.retry(body.feature as string, text('note')) ? { done: true } : { done: false, error: 'refused: the state changed meanwhile' });
        }
        case 'POST /api/message': {
          if (text('text') === undefined) return sendJson(res, { done: false, error: 'the message is empty' });
          const manager = text('manager');
          if (manager !== undefined && !own(orchestrator.state.managers, manager)) return sendJson(res, { done: false, error: 'no such Manager' });
          return sendJson(res, orchestrator.messageManager(text('text')!, manager) ? { done: true } : { done: false, error: 'no Manager is running to read it' });
        }
        case 'POST /api/attach': {
          // `harness attach` reports that it opened, or left, the Architect's terminal: a nudge then waits for a quiet moment.
          const module = own(orchestrator.state.modules, body.module);
          if (!module || typeof body.attached !== 'boolean') return sendJson(res, { done: false, error: 'module: a module of this project; attached: true or false' });
          terminals.attachOutside(module.architect.sandbox, body.attached);
          if (!body.attached && terminals.available) void announce(terminals.announceDue());
          return sendJson(res, { done: true });
        }
        case 'POST /api/modules': {
          if (typeof body.id !== 'string') return sendJson(res, { done: false, error: 'a module needs an id' });
          if (!(body.ownerHours === undefined || typeof body.ownerHours === 'number')) return sendJson(res, { done: false, error: 'the hours are a number' });
          const error = orchestrator.createModule(body.id, typeof body.title === 'string' ? body.title : '', body.ownerHours);
          return sendJson(res, error ? { done: false, error } : { done: true });
        }
        case 'POST /api/accept': {
          const module = own(orchestrator.state.modules, body.module);
          if (!module || typeof body.version !== 'number') return sendJson(res, { done: false, error: 'no such module, or no version' });
          return sendJson(res, orchestrator.acceptProposal(module.module, body.version) ? { done: true } : { done: false, error: `v${body.version} of ${module.module} can't be accepted now: the module is ${module.status.replace(/_/g, ' ')}` });
        }
        case 'POST /api/actions/done': {
          if (typeof body.module !== 'string' || typeof body.action !== 'string') return sendJson(res, { done: false, error: 'which action?' });
          const status = own(orchestrator.state.actions, `${body.module}/${body.action}`)?.status;
          if (status === 'done' || status === 'verifying') return sendJson(res, { done: false, error: status === 'done' ? 'it is done already' : 'its check is running' });
          return sendJson(res, orchestrator.claimAction(body.module, body.action, text('note')) ? { done: true } : { done: false, error: 'the design on main has no such action' });
        }
        case 'POST /api/answer': {
          const request = own(orchestrator.state.ownerRequests, body.id);
          if (!request) return sendJson(res, { done: false, error: 'no such question' });
          if (request.answer !== undefined) return sendJson(res, { done: false, error: 'it was answered already' });
          if (text('text') === undefined) return sendJson(res, { done: false, error: 'the answer is empty' });
          return sendJson(res, orchestrator.answerOwnerRequest(request.requestId, text('text')!) ? { done: true } : { done: false, error: 'refused: the state changed meanwhile' });
        }
      }
      send(res, 404, 'not found');
    } catch (error) {
      if (!res.headersSent) send(res, 500, (error as Error).message);
      else res.end();
    }
  });

  // Terminals: the same checks as any request, and a browser always sends its Origin.
  // A paste comes as one message: 1 MiB holds a long one, and the page sends it in slices anyway.
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    // A client that hangs up while it is refused makes the socket emit an error, which would stop the daemon.
    socket.on('error', () => {});
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) throw new Error('wrong host');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!sameOrigin(req.headers.origin) || !authorized(req, url) || url.pathname !== '/api/terminal') {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      sockets.handleUpgrade(req, socket, head, (ws) => openTerminal(ws, url, orchestrator.state, terminals));
    } catch {
      socket.destroy();
    }
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
        // Once it listens, a server error is only logged: nothing a client does may stop the daemon.
        server.on('error', (error) => orchestrator.log(`dashboard: ${error.message}`));
        const actual = (server.address() as AddressInfo).port;
        allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
        cookie = `harness_token_${actual}`;
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
  // A message over maxPayload, or a socket torn down, emits an error: without a listener, it would stop the daemon.
  ws.on('error', () => {});
  ws.on('close', () => terminal.detach());
}

/**
 * The sandboxes the owner may open a shell in: the agents' that are still there. An
 * attempt's goes as its checks start, which run in a sandbox of their own; the page's
 * Agents view offers a shell for the same statuses.
 */
export function runningSandboxes(state: State): string[] {
  const live = ['starting', 'running', 'collecting'];
  return [
    ...Object.values(state.modules).map((m) => m.architect.sandbox),
    ...Object.values(state.managers).filter((m) => m.status !== 'stopped').map((m) => m.sandbox),
    ...Object.values(state.features).flatMap((f) => f.attempts.filter((a) => live.includes(a.status)).map((a) => a.sandbox)),
    ...Object.values(state.plans).flatMap((p) => (p.reviews ?? []).filter((r) => r.status === 'starting' || r.status === 'running').map((r) => r.sandbox)),
  ];
}

/** A secret given in a request, compared in constant time. Bytes, not characters: timingSafeEqual throws on lengths that differ. */
function matches(given: string | null | undefined, secret: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The agents' stream-json, for the live transcripts (§14.3). Recent lines stay in memory;
 * an attempt that ended, or a Manager's earlier session, is read back from its file. A
 * Developer's and a reviewer's transcripts open with the prompt they read on stdin, which
 * their stream-json doesn't repeat; the Manager's messages come back in its own.
 */
class Transcripts {
  private readonly live = new Map<string, unknown[]>();
  private readonly orchestrator: Orchestrator;

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  /** Keeps one line of an agent's stream. Returns what the open pages get: the agent's prompt before its first line. */
  add(agent: string, line: string): unknown[] {
    const item = parseLine(line);
    if (item === undefined) return [];
    const first = !this.live.has(agent);
    const items = this.live.get(agent) ?? [];
    items.push(item);
    if (items.length > 1000) items.shift();
    this.live.delete(agent);
    this.live.set(agent, items);
    // The oldest agents go first: only recent ones are watched live.
    if (this.live.size > 20) this.live.delete(this.live.keys().next().value!);
    const prompt = first ? this.prompt(agent) : undefined;
    return prompt === undefined ? [item] : [prompt, item];
  }

  get(agent: string): unknown[] | undefined {
    const items = this.live.get(agent) ?? this.saved(agent);
    if (!items) return undefined;
    const prompt = this.prompt(agent);
    return prompt === undefined ? items : [prompt, ...items];
  }

  private saved(agent: string): unknown[] | undefined {
    const file = this.file(agent);
    if (!file || !existsSync(file)) return undefined;
    return readFileSync(file, 'utf8').split('\n').map(parseLine).filter((item) => item !== undefined).slice(-1000);
  }

  /** What a Developer or a reviewer read on stdin: its task, or its brief. */
  private prompt(agent: string): unknown {
    const attempt = this.attemptDir(agent);
    const review = attempt ? undefined : this.reviewDir(agent);
    const file = attempt ? join(attempt, 'task.md') : review ? join(review, 'brief.md') : undefined;
    if (!file || !existsSync(file)) return undefined;
    return clip({ type: 'prompt', text: readFileSync(file, 'utf8') }, 0);
  }

  /** Only files the state names: the attempt of a known feature, a known review, or a module's Manager. */
  private file(agent: string): string | undefined {
    const attempt = this.attemptDir(agent);
    if (attempt) return join(attempt, 'stream.jsonl');
    // A review's stream is saved in its folder as its session ends.
    const review = this.reviewDir(agent);
    if (review) return join(review, 'stream.jsonl');
    // A module's Manager, or a plan's (v3 §6.4): each keeps its transcripts in its own folder.
    const manager = /^manager:([^/]+)(?:\/([^/]+))?$/.exec(agent);
    if (!manager) return undefined;
    const [, module, plan] = manager;
    const session = this.orchestrator.state.managers[plan ? `${module}/${plan}` : module!]?.sessionId;
    if (!session) return undefined;
    const harnessDir = this.orchestrator.options.harnessDir;
    return plan
      ? join(harnessDir, 'modules', module!, 'plans', plan, 'manager', `transcript-${session}.jsonl`)
      : join(harnessDir, 'modules', module!, 'manager', `transcript-${session}.jsonl`);
  }

  /** The folder of an attempt the state knows, for "developer:<module>/<plan>/<feature>/a<n>". */
  private attemptDir(agent: string): string | undefined {
    const developer = /^developer:([^/]+)\/([^/]+)\/([^/]+)\/a(\d+)$/.exec(agent);
    if (!developer) return undefined;
    const [, module, plan, feature, n] = developer;
    const attempt = this.orchestrator.state.features[`${module}/${plan}/${feature}`]?.attempts.find((a) => a.n === Number(n));
    return attempt ? join(this.orchestrator.options.harnessDir, 'modules', module!, 'attempts', `${plan}-${feature}-a${n}`) : undefined;
  }

  /** The folder of a review the state knows, for "<role>:<first 8 characters of the head>". */
  private reviewDir(agent: string): string | undefined {
    for (const plan of Object.values(this.orchestrator.state.plans)) {
      const review = plan.reviews?.findLast((r) => `${r.role}:${r.head.slice(0, 8)}` === agent);
      if (review) return join(this.orchestrator.options.harnessDir, 'modules', plan.module, 'reviews', `${plan.plan}-${review.role}-${review.head.slice(0, 8)}`);
    }
    return undefined;
  }
}

/** The most a transcript item weighs once serialized: it bounds what the 1,000 items an agent keeps in memory can hold. */
export const MAX_ITEM = 64 * 1024;
/** How deep a transcript item goes: stream-json's own items stay well above it. */
const MAX_DEPTH = 8;

/**
 * One stream-json line, with long strings cut, as a tool's output can be megabytes, what
 * lies deeper than the limit replaced, and an item too heavy replaced as a whole. An agent
 * writes these lines: nothing in one may make the dashboard throw.
 */
export function parseLine(line: string): unknown {
  if (!line.trim()) return undefined;
  try {
    const item = clip(JSON.parse(line), 0);
    const size = JSON.stringify(item).length;
    return size > MAX_ITEM ? { type: 'clipped', text: `an item of ${size} characters, too large to show` } : item;
  } catch {
    return undefined;
  }
}

function clip(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}… (${value.length - 4000} more characters)` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '… (nested too deep to show)';
  if (Array.isArray(value)) return value.map((v) => clip(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, depth + 1)]));
}

/**
 * The built dashboard: only files under its folder, and its `index.html` for anything else,
 * /next/ included, where 0.4.17 served it beside the first one.
 */
function serveFile(res: ServerResponse, webRoot: string, path: string, hosts: string[]): void {
  const root = normalize(webRoot + sep);
  const candidate = normalize(join(webRoot, decodeURIComponent(path)));
  const page = join(webRoot, 'index.html');
  const file = candidate.startsWith(root) && existsSync(candidate) && extname(candidate) !== '' ? candidate : page;
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
    const read = (chunk: string) => {
      body += chunk;
      if (body.length <= 64 * 1024) return;
      // Refused: the rest is read and dropped, never kept, so the answer can still be sent.
      req.off('data', read);
      body = '';
      req.resume();
      reject(new Error('body too large'));
    };
    req.on('data', read);
    req.on('end', () => resolve(body || '{}'));
    req.on('error', reject);
  });
}

/** A record's own entry for a key a request gave, never one of Object.prototype's (`__proto__`, `constructor`). */
function own<T>(record: Record<string, T>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(record, key) ? record[key] : undefined;
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
