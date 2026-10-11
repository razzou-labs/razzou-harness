import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/**
 * `web_read` (proposal v2 §13): the daemon reads a public page for an agent, outside the
 * sandbox. GET only, at most five redirects, and every address is checked when it is
 * connected to, so neither a redirect nor a DNS answer can reach the owner's network,
 * the dashboard or a cloud metadata service.
 */
export interface WebReadOptions {
  /** Which resolved addresses may be connected to. Tests loosen it; the daemon never does. */
  allowAddress?: (ip: string) => boolean;
  /** Which ports, 80 and 443 by default. */
  allowPort?: (port: number) => boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
}

export interface WebReadResult {
  ok: boolean;
  /** The page as text, or why it was refused. */
  text: string;
  finalUrl?: string;
  status?: number;
  bytes: number;
}

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(net, prefix, 'ipv4');
// No ::ffff:0:0/96 here: BlockList checks IPv4 addresses against IPv4-mapped rules too, so
// that rule would block every IPv4 address. Mapped addresses are unwrapped below instead.
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) PRIVATE.addSubnet(net, prefix, 'ipv6');

/** Not loopback, private, link-local, carrier-grade NAT (Tailscale), multicast or reserved, even when written as IPv6. */
export function isPublicAddress(ip: string): boolean {
  const mapped = unmapIPv4(ip);
  if (mapped !== undefined) return isPublicAddress(mapped);
  const family = isIP(ip);
  return family !== 0 && !PRIVATE.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** The IPv4 address inside an IPv4-mapped IPv6 one (`::ffff:127.0.0.1` or `::ffff:7f00:1`). */
function unmapIPv4(ip: string): string | undefined {
  if (isIP(ip) !== 6) return undefined;
  const lower = ip.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,4}:?:ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (dotted) return dotted;
  const hex = /^(?:0{0,4}:){0,4}:?:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return undefined;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/** Places to drop or collect data rather than read documentation: paste sites, tunnels, request catchers, chat, storage. */
const NEVER = [
  'pastebin.com', 'paste.ee', 'hastebin.com', 'ghostbin.com', 'dpaste.org', 'dpaste.com', 'rentry.co', 'controlc.com',
  'privatebin.net', 'termbin.com', 'transfer.sh', 'file.io', '0x0.st', 'tmpfiles.org',
  'ngrok.io', 'ngrok.app', 'ngrok-free.app', 'trycloudflare.com', 'loca.lt', 'localtunnel.me', 'serveo.net',
  'webhook.site', 'requestbin.com', 'pipedream.net', 'beeceptor.com', 'hookbin.com', 'requestcatcher.com',
  'interact.sh', 'oast.fun', 'oast.pro', 'oast.live', 'oast.site', 'burpcollaborator.net',
  'discord.com', 'discordapp.com', 'slack.com', 'telegram.org', 't.me', 'whatsapp.com',
  'drive.google.com', 'docs.google.com', 'dropbox.com', 'dropboxusercontent.com', 'onedrive.live.com', '1drv.ms',
  'box.com', 'mega.nz', 'wetransfer.com',
  'amazonaws.com', 'storage.googleapis.com', 'blob.core.windows.net', 'r2.dev', 'digitaloceanspaces.com',
];

export function neverRead(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return NEVER.some((never) => name === never || name.endsWith(`.${never}`));
}

class Refused extends Error {}

export async function webRead(address: string, options: WebReadOptions = {}): Promise<WebReadResult> {
  const allow = options.allowAddress ?? isPublicAddress;
  const allowPort = options.allowPort ?? ((port: number) => port === 80 || port === 443);
  const maxChars = options.maxChars ?? 100_000;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { ok: false, text: `not a URL: ${address}`, bytes: 0 };
  }
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const response = await get(url, allow, allowPort, options.timeoutMs ?? 20_000, options.maxBytes ?? 2_000_000);
      if (response.location !== undefined) {
        if (hop === 5) return { ok: false, text: `more than 5 redirects, the last to ${response.location}`, bytes: 0 };
        url = new URL(response.location, url);
        continue;
      }
      const text = toText(response.body, response.type, url);
      if (text === undefined) {
        return { ok: false, text: `${url.href} is ${response.type || 'of an unknown type'}, not text`, status: response.status, bytes: response.body.length };
      }
      const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[cut at ${maxChars} characters]` : text;
      const cut = response.truncated ? '\n\n[the page was larger than the size limit; this is its beginning]' : '';
      return {
        ok: response.status < 400,
        text: `URL: ${url.href}\nStatus: ${response.status}\n\n${clipped}${cut}`,
        finalUrl: url.href,
        status: response.status,
        bytes: response.body.length,
      };
    }
  } catch (error) {
    const refused = error instanceof Refused || (error as { code?: string }).code === 'EHARNESS_REFUSED';
    return { ok: false, text: `${refused ? 'refused' : 'failed'}: ${(error as Error).message}`, finalUrl: url.href, bytes: 0 };
  }
  return { ok: false, text: 'too many redirects', bytes: 0 };
}

interface Response {
  status: number;
  location?: string;
  type: string;
  body: Buffer;
  truncated: boolean;
}

function get(url: URL, allow: (ip: string) => boolean, allowPort: (port: number) => boolean, timeoutMs: number, maxBytes: number): Promise<Response> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refused(`only http and https, not ${url.protocol}`);
  if (url.username || url.password) throw new Refused('URLs with credentials are refused');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!allowPort(port)) throw new Refused(`port ${port}: only 80 and 443`);
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (neverRead(host)) throw new Refused(`${host} is on the harness's never list`);
  if (isIP(host) !== 0 && !allow(host)) throw new Refused(`${host} is not a public address`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, response?: Response) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(response!);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        lookup: checkedLookup(allow),
        headers: {
          'user-agent': 'razzou-harness web_read',
          accept: 'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          finish(undefined, { status, location, type: '', body: Buffer.alloc(0), truncated: false });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const done = (truncated: boolean) =>
          finish(undefined, { status, type: String(response.headers['content-type'] ?? ''), body: Buffer.concat(chunks), truncated });
        const body = decoded(response);
        body.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size > maxBytes) {
            done(true);
            request.destroy();
          }
        });
        body.on('end', () => done(false));
        body.on('error', (error) => finish(error));
      },
    );
    const deadline = setTimeout(() => request.destroy(new Error(`no complete answer within ${timeoutMs / 1000} s`)), timeoutMs);
    request.on('error', (error) => finish(error));
    request.end();
  });
}

/** Resolves like the system does, then refuses unless every address is allowed. The socket connects to what was checked. */
function checkedLookup(allow: (ip: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error, '', 0);
      const refused = addresses.find((a) => !allow(a.address));
      if (refused || addresses.length === 0) {
        const message = refused ? `${hostname} resolves to ${refused.address}, which is not a public address` : `${hostname} has no address`;
        return callback(Object.assign(new Error(message), { code: 'EHARNESS_REFUSED' }), '', 0);
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

function decoded(response: IncomingMessage): Readable {
  switch (String(response.headers['content-encoding'] ?? '').toLowerCase()) {
    case 'gzip':
      return response.pipe(createGunzip());
    case 'deflate':
      return response.pipe(createInflate());
    case 'br':
      return response.pipe(createBrotliDecompress());
    default:
      return response;
  }
}

/** The body as text: HTML is reduced to its readable text and links; other text types pass through. */
function toText(body: Buffer, type: string, base: URL): string | undefined {
  const mime = type.split(';')[0]!.trim().toLowerCase();
  const textual = mime === '' || mime.startsWith('text/') || /[/+](json|xml|javascript|yaml|x-yaml|toml)$/.test(mime);
  if (!textual) return undefined;
  const charset = /charset=([^;]+)/i.exec(type)?.[1]?.trim().replace(/^"|"$/g, '') ?? 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(charset).decode(body);
  } catch {
    text = new TextDecoder('utf-8').decode(body);
  }
  return mime === 'text/html' || mime === 'application/xhtml+xml' || (mime === '' && /<html[\s>]/i.test(text)) ? htmlToText(text, base) : text;
}

export function htmlToText(html: string, base?: URL): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, d, s, u, inner: string) => {
      const href = decodeEntities(String(d ?? s ?? u ?? ''));
      const label = inner.replace(/<[^>]+>/g, '').trim();
      if (!label || href.startsWith('#') || /^(javascript|mailto|data):/i.test(href)) return label;
      let target = href;
      try {
        target = new URL(href, base).href;
      } catch {
        // Keep it as written.
      }
      return `${label} (${target})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(pre|code)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|aside|tr|h[1-6]|pre|blockquote|table|ul|ol|dl|dt|dd|header|footer|nav|figure)\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  const text = decodeEntities(body)
    .replace(/[ \t\f\v\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return title ? `# ${decodeEntities(title).replace(/\s+/g, ' ').trim()}\n\n${text}` : text;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return ENTITIES[code.toLowerCase()] ?? entity;
  });
}
