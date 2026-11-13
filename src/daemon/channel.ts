import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Follower, SandboxDriver } from '../sandbox/driver.ts';
import { sh } from '../util.ts';

/** A tool call, as the shim appends it to the outbox. */
export const RequestSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  ts: z.string().optional(),
  tool: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()),
});
export type AgentRequest = z.infer<typeof RequestSchema>;

const MAX_LINE = 64 * 1024;

/**
 * An agent can write request lines straight into its outbox, as fast and as many as it
 * likes, and each one costs the daemon work and the event log a record. So a sandbox's
 * requests are handled two at a time, and those over sixty a minute are refused.
 */
export const CONCURRENCY = 2;
export const RATE_PER_MINUTE = 60;

export interface ChannelOptions {
  driver: SandboxDriver;
  sandbox: string;
  outbox: string;
  inbox: string;
  /** On the host: ids of requests already answered. */
  repliedFile: string;
  /** Handles a request; the next one waits for the promise it returns, if any. */
  onRequest: (request: AgentRequest) => void | Promise<unknown>;
  onInvalid: (reason: string) => void;
}

/**
 * One agent's channel to the daemon (proposal v2 §9.2). Its tool calls arrive as lines of
 * `outbox.jsonl`, which the daemon follows from outside the sandbox, and replies go to
 * `inbox.jsonl`. The sender is whichever sandbox the line came from: writing to one's own
 * outbox only ever speaks as oneself. Answered ids are kept on the host, so after a
 * restart the outbox is read again from the start without answering anything twice.
 */
export class AgentChannel {
  readonly sandbox: string;
  private readonly options: ChannelOptions;
  private readonly replied: Set<string>;
  private readonly seen = new Set<string>();
  private follower?: Follower;
  private writes: Promise<void> = Promise.resolve();
  /** When each of the last minute's accepted requests arrived. */
  private readonly accepted: number[] = [];
  private readonly queue: AgentRequest[] = [];
  private running = 0;

  constructor(options: ChannelOptions) {
    this.options = options;
    this.sandbox = options.sandbox;
    mkdirSync(dirname(options.repliedFile), { recursive: true });
    this.replied = new Set(existsSync(options.repliedFile) ? readFileSync(options.repliedFile, 'utf8').split('\n').filter(Boolean) : []);
  }

  start(): void {
    this.follower ??= this.options.driver.follow(this.sandbox, this.options.outbox, 1, (line) => this.receive(line));
  }

  stop(): void {
    this.follower?.stop();
    this.follower = undefined;
  }

  isAnswered(id: string): boolean {
    return this.replied.has(id);
  }

  /** Appends a reply to the inbox. Replies are written one at a time, so lines never interleave. */
  reply(id: string, ok: boolean, text: string): Promise<void> {
    const line = `${JSON.stringify({ replyTo: id, ok, text })}\n`;
    const write = this.writes.then(async () => {
      const result = await this.options.driver.exec(this.sandbox, `cat >> ${sh(this.options.inbox)}`, { input: line, timeoutSec: 60 });
      if (result.code !== 0) throw new Error(`could not reply in ${this.sandbox}: ${(result.stderr || result.stdout).trim()}`);
      this.replied.add(id);
      appendFileSync(this.options.repliedFile, `${id}\n`);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  private receive(line: string): void {
    if (line.trim() === '') return;
    if (line.length > MAX_LINE) {
      // Not parsed, but its id is near the start: the agent hears why, instead of waiting out its call.
      const id = /"id"\s*:\s*"([A-Za-z0-9-]{1,64})"/.exec(line.slice(0, 300))?.[1];
      if (id && !this.replied.has(id)) {
        void this.reply(id, false, `the request is too large: ${line.length} characters, where the limit is ${MAX_LINE}`).catch(() => {});
      }
      return this.options.onInvalid(`a request of ${line.length} characters (the limit is ${MAX_LINE})`);
    }
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return this.options.onInvalid('a line that is not JSON');
    }
    const parsed = RequestSchema.safeParse(json);
    if (!parsed.success) {
      const id = (json as { id?: unknown })?.id;
      if (typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id) && !this.replied.has(id)) {
        void this.reply(id, false, `invalid request: ${z.prettifyError(parsed.error)}`).catch(() => {});
      }
      return this.options.onInvalid(`an invalid request: ${z.prettifyError(parsed.error)}`);
    }
    const request = parsed.data;
    if (this.replied.has(request.id) || this.seen.has(request.id)) return;
    this.seen.add(request.id);
    const now = Date.now();
    while (this.accepted.length > 0 && this.accepted[0]! <= now - 60_000) this.accepted.shift();
    if (this.accepted.length >= RATE_PER_MINUTE) {
      void this.reply(request.id, false, `too many requests: at most ${RATE_PER_MINUTE} a minute from one sandbox. Wait a minute and call again.`).catch(() => {});
      return this.options.onInvalid(`a request over the rate of ${RATE_PER_MINUTE} a minute`);
    }
    this.accepted.push(now);
    this.queue.push(request);
    this.next();
  }

  /** Hands queued requests over while fewer than CONCURRENCY are being handled. */
  private next(): void {
    while (this.running < CONCURRENCY && this.queue.length > 0) {
      const request = this.queue.shift()!;
      this.running++;
      let handled: Promise<unknown>;
      try {
        handled = Promise.resolve(this.options.onRequest(request));
      } catch (error) {
        handled = Promise.reject(error);
      }
      void handled.catch(() => {}).finally(() => {
        this.running--;
        this.next();
      });
    }
  }
}
