import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { finished, pipeline, type Readable, type Transform } from 'node:stream';
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
  /** For the whole read, redirects included: 75 s, under the 90 s the agent's call waits. */
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
  // Azure's host endpoint (WireServer), a public address that answers inside every Azure VM.
  ['168.63.129.16', 32],
] as const) PRIVATE.addSubnet(net, prefix, 'ipv4');
// No ::ffff:0:0/96 here: BlockList checks IPv4 addresses against IPv4-mapped rules too, so
// that rule would block every IPv4 address. Mapped addresses are unwrapped below instead.
// The other forms that carry an IPv4 address, IPv4-compatible (`::127.0.0.1`, which holds
// `::` and `::1` too) and IPv4-translated (`::ffff:0:127.0.0.1`), are refused whole: no
// public site is reached that way, and the system may route them to the IPv4 address.
// fec0::/10 is the old site-local range, private like fc00::/7.
for (const [net, prefix] of [
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
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

/**
 * Whether `ip` is one of this machine's addresses, or on one of its networks. Those can be
 * public too: with IPv6, or a public IPv4 on an interface, the machine's own services and
 * its router are as reachable as any site. The daemon reads its interfaces at each request.
 */
export function onHostNetwork(ip: string, interfaces: NetworkInterfaceInfo[]): boolean {
  const address = unmapIPv4(ip) ?? ip;
  const family = isIP(address);
  if (family === 0) return false;
  const own = new BlockList();
  for (const i of interfaces) {
    if (i.internal) continue;
    const type = i.family === 'IPv4' ? 'ipv4' : 'ipv6';
    const [net, prefix] = (i.cidr ?? `${i.address}/${type === 'ipv4' ? 32 : 128}`).split('/');
    own.addSubnet(net!, Number(prefix), type);
  }
  return own.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** What the daemon lets web_read connect to: public addresses, none of them this machine's or on its networks. */
function isReadable(ip: string): boolean {
  return isPublicAddress(ip) && !onHostNetwork(ip, Object.values(networkInterfaces()).flatMap((list) => list ?? []));
}

/** Places to drop or collect data rather than read documentation: paste sites, tunnels, request catchers, chat, storage. */
const NEVER = [
  'pastebin.com', 'paste.ee', 'hastebin.com', 'ghostbin.com', 'dpaste.org', 'dpaste.com', 'rentry.co', 'controlc.com',
  'privatebin.net', 'termbin.com', 'transfer.sh', 'file.io', '0x0.st', 'tmpfiles.org',
  'ngrok.io', 'ngrok.app', 'ngrok-free.app', 'trycloudflare.com', 'loca.lt', 'localtunnel.me', 'serveo.net',
  'webhook.site', 'requestbin.com', 'pipedream.net', 'beeceptor.com', 'hookbin.com', 'requestcatcher.com',
  'interact.sh', 'oast.fun', 'oast.pro', 'oast.live', 'oast.site', 'burpcollaborator.net',
  'discord.com', 'discordapp.com', 'slack.com', 'telegram.org', 't.me', 'whatsapp.com', 'claude.ai', 'chatgpt.com',
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
  const allow = options.allowAddress ?? isReadable;
  const allowPort = options.allowPort ?? ((port: number) => port === 80 || port === 443);
  const maxChars = options.maxChars ?? 100_000;
  const timeoutMs = options.timeoutMs ?? 75_000;
  // One deadline for every hop: six slow ones must not outlast the agent's wait.
  const deadline = AbortSignal.timeout(timeoutMs);
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { ok: false, text: `not a URL: ${address}`, bytes: 0 };
  }
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const response = await get(url, allow, allowPort, deadline, options.maxBytes ?? 2_000_000);
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
    const why = !refused && deadline.aborted ? `no complete answer within ${timeoutMs / 1000} s` : (error as Error).message;
    return { ok: false, text: `${refused ? 'refused' : 'failed'}: ${why}`, finalUrl: url.href, bytes: 0 };
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

function get(url: URL, allow: (ip: string) => boolean, allowPort: (port: number) => boolean, deadline: AbortSignal, maxBytes: number): Promise<Response> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refused(`only http and https, not ${url.protocol}`);
  if (url.username || url.password) throw new Refused('URLs with credentials are refused');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!allowPort(port)) throw new Refused(`port ${port}: only 80 and 443`);
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (neverRead(host)) throw new Refused(`${host} is on the harness's never list`);
  if (isIP(host) !== 0 && !allow(host)) throw new Refused(`${host} is not a public address`);

  return new Promise((resolve, reject) => {
    let settled = false;
    // The deadline settles the call whatever the streams do: a decoder fed a body cut
    // short may never end nor fail.
    const expired = () => {
      finish(new Error('the deadline passed'));
      request.destroy();
    };
    const finish = (error: Error | undefined, response?: Response) => {
      if (settled) return;
      settled = true;
      deadline.removeEventListener('abort', expired);
      if (error) reject(error);
      else resolve(response!);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        signal: deadline,
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
        // A response cut short, or its decoder failing, ends the call with an error.
        const decoder = decoderOf(response);
        const body: Readable = decoder ?? response;
        const failed = (error?: Error | null) => {
          if (error) finish(error);
        };
        if (decoder) pipeline(response, decoder, failed);
        else finished(response, failed);
        body.on('data', (chunk: Buffer) => {
          if (size > maxBytes) return;
          chunks.push(chunk.subarray(0, maxBytes - size));
          size += chunk.length;
          if (size > maxBytes) {
            done(true);
            // A few kB of brotli can decode to gigabytes: the decoder stops here too, not only the download.
            body.destroy();
            request.destroy();
          }
        });
        body.on('end', () => done(false));
      },
    );
    request.on('error', (error) => finish(error));
    deadline.addEventListener('abort', expired, { once: true });
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

/** The decoder of the response's content encoding, if it has one. */
function decoderOf(response: IncomingMessage): Transform | undefined {
  switch (String(response.headers['content-encoding'] ?? '').toLowerCase()) {
    case 'gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return undefined;
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

/**
 * HTML as readable text, with its links. The tags are read in one pass, each found with
 * indexOf, so the time is linear: an element's end is searched for once, and an end found
 * missing is missing for the rest of the page. Lazy patterns like `<!--[\s\S]*?-->` scanned
 * the rest of the page again for each unclosed opener: minutes, for 2 MB of `<!--`.
 */
export function htmlToText(html: string, base?: URL): string {
  const title = titleOf(html);
  const body = readable(html, base, false);
  const text = decodeEntities(body)
    .replace(/[ \t\f\v\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return title ? `# ${decodeEntities(title).replace(/\s+/g, ' ').trim()}\n\n${text}` : text;
}

/** The first `<title>`'s text, found the same way. */
function titleOf(html: string): string | undefined {
  const open = html.search(/<title/i);
  const start = open < 0 ? -1 : html.indexOf('>', open);
  if (start < 0) return undefined;
  const close = /<\/title>/gi;
  close.lastIndex = start + 1;
  const end = close.exec(html)?.index;
  return end === undefined ? undefined : html.slice(start + 1, end);
}

/** The text between the tags, with what the tags stand for. `plain`, for a link's label, drops every tag. */
function readable(html: string, base: URL | undefined, plain: boolean): string {
  const missing = new Set<string>();
  /** The first match of `close` from `from` on. */
  const find = (close: RegExp, from: number): { start: number; end: number } | undefined => {
    if (missing.has(close.source)) return undefined;
    close.lastIndex = from;
    const found = close.exec(html);
    if (!found) missing.add(close.source);
    return found ? { start: found.index, end: found.index + found[0].length } : undefined;
  };
  let out = '';
  let at = 0;
  for (let lt = html.indexOf('<'); lt >= 0; lt = html.indexOf('<', at)) {
    // A comment ends at `-->`, or at `--!>` as browsers also read it.
    const comment = html.startsWith('<!--', lt) ? find(/--!?>/g, lt + 4) : undefined;
    const gt = comment ? comment.end - 1 : html.indexOf('>', lt + 1);
    // No tag ends after this point: the rest is text.
    if (gt < 0) break;
    out += html.slice(at, lt);
    at = gt + 1;
    if (comment) {
      out += ' ';
      continue;
    }
    // `<>` is text.
    if (gt === lt + 1) {
      out += '<';
      at = gt;
      continue;
    }
    const tag = html.slice(lt + 1, gt);
    const hidden = /^(script|style|noscript|template|svg|head|iframe)\b/i.exec(tag)?.[1]!.toLowerCase();
    const hiddenEnd = hidden ? find(new RegExp(`</${hidden}\\s*>`, 'gi'), at) : undefined;
    if (hiddenEnd) {
      out += ' ';
      at = hiddenEnd.end;
      continue;
    }
    const href = !plain && /^a\b/i.test(tag) ? /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag) : null;
    const linkEnd = href ? find(/<\/a\s*>/gi, at) : undefined;
    if (href && linkEnd) {
      out += link(readable(html.slice(at, linkEnd.start), base, true).trim(), decodeEntities(href[1] ?? href[2] ?? href[3] ?? ''), base);
      at = linkEnd.end;
      continue;
    }
    if (!plain) out += tagText(tag);
  }
  return out + html.slice(at);
}

/** A link: its label, and where it goes when that is another page. */
function link(label: string, href: string, base: URL | undefined): string {
  if (!label || href.startsWith('#') || /^(javascript|mailto|data):/i.test(href)) return label;
  let target = href;
  try {
    target = new URL(href, base).href;
  } catch {
    // Keep it as written.
  }
  return `${label} (${target})`;
}

/** What a tag stands for in text: a line break, a heading's or a list item's mark, a cell's bar, or nothing. */
function tagText(tag: string): string {
  if (/^br\s*\/?$/i.test(tag)) return '\n';
  const heading = /^h([1-6])\b/i.exec(tag)?.[1];
  if (heading) return `\n\n${'#'.repeat(Number(heading))} `;
  if (/^li\b/i.test(tag)) return '\n- ';
  if (/^(pre|code)\b/i.test(tag)) return '\n';
  if (/^\/(p|div|section|article|main|aside|tr|h[1-6]|pre|blockquote|table|ul|ol|dl|dt|dd|header|footer|nav|figure)\s*$/i.test(tag)) return '\n';
  if (/^\/t[dh]\s*$/i.test(tag)) return ' | ';
  return '';
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
