// The harness's CI checks (proposal v2 §8.7, §11.5). Vendored into each project as
// `.github/harness/harness-ci.ts`, where the harness workflow runs it with Node 24 from
// the base branch, and imported by the daemon for the same rules. It stands alone: only
// `node:` imports, and only TypeScript that Node can strip.
//
//   node harness-ci.ts verify --base <dir> --head <dir> --base-sha <sha> --head-sha <sha>
//                             --author <login> --branch <name> --title <title>
//   node harness-ci.ts checks --definitions <dir> --dir <dir>
//   node harness-ci.ts lock --dir <dir>
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

/** A tree to read: a checkout in CI, a commit in the daemon. */
export interface TreeReader {
  read(path: string): Promise<string | undefined>;
  /** Every file under a folder, as paths from the root. */
  list(folder: string): Promise<string[]>;
}

export function directoryReader(root: string): TreeReader {
  return {
    async read(path) {
      const file = join(root, path);
      return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : undefined;
    },
    async list(folder) {
      const start = join(root, folder);
      if (!existsSync(start)) return [];
      return (readdirSync(start, { recursive: true, encoding: 'utf8' }) as string[])
        .map((entry) => join(start, entry))
        .filter((file) => statSync(file).isFile() && !relative(root, file).startsWith('.git/'))
        .map((file) => relative(root, file));
    },
  };
}

/** Paths no Plan or Fix PR may change, in every project. */
export const ALWAYS_PROTECTED = ['harness/**', '.github/**', '.claude/**', 'CLAUDE.md', 'AGENTS.md', 'ARCHITECTURE.md', 'init.sh', '.npmrc'];

/** Tool configs written as code: protected whole when they exist. */
const TOOL_FILES = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs',
  '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', 'vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.workspace.ts',
  'jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'playwright.config.ts', 'playwright.config.js', 'biome.json', 'biome.jsonc',
  '.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js', 'prettier.config.mjs',
];

/** JSON configs: protected by field, so ordinary changes stay possible. */
const JSON_FIELDS: Record<string, string[]> = {
  'tsconfig.json': ['/compilerOptions/strict', '/compilerOptions/noImplicitAny', '/compilerOptions/skipLibCheck', '/exclude'],
};

export interface ProtectionRules {
  /** A path matching one of these may not change at all. */
  paths: string[];
  /** These JSON fields, by file, may not change. A missing field counts as a value. */
  fields: Record<string, string[]>;
}

interface Check {
  id: string;
  run: string;
  phase: string;
  timeoutSec?: number;
  needs?: string[];
}

/** The rules a tree's own `harness/config.json` and plans set. The base of a change decides them. */
export async function protectionRules(tree: TreeReader): Promise<ProtectionRules> {
  const config = parseJson(await tree.read('harness/config.json')) as { checks?: Check[]; protect?: { files?: string[]; jsonFields?: Record<string, string[]> } } | undefined;
  const fields: Record<string, string[]> = {};
  const add = (file: string, pointers: string[]) => {
    fields[file] = [...new Set([...(fields[file] ?? []), ...pointers])];
  };
  for (const [file, pointers] of Object.entries(JSON_FIELDS)) add(file, pointers);
  for (const [file, pointers] of Object.entries(config?.protect?.jsonFields ?? {})) add(file, pointers);
  // A check written as `npm run X` is only as good as the script X, and the hooks npm runs around it.
  const checks = [...(config?.checks ?? []), ...(await designChecks(tree)).map((c) => c.check)];
  for (const script of new Set(checks.flatMap((c) => npmScripts(c.run)))) {
    add('package.json', [`/scripts/${script}`, `/scripts/pre${script}`, `/scripts/post${script}`]);
  }
  return { paths: [...ALWAYS_PROTECTED, ...TOOL_FILES, ...(config?.protect?.files ?? [])], fields };
}

/** npm scripts a command line runs: `npm run lint`, `npm test`, `npm start`. */
export function npmScripts(command: string): string[] {
  const scripts: string[] = [];
  for (const match of command.matchAll(/\bnpm\s+(?:run(?:-script)?\s+([\w:.-]+)|(test|t|start|stop|restart)\b)/g)) {
    scripts.push(match[1] ?? (match[2] === 't' ? 'test' : match[2]!));
  }
  return scripts;
}

export function matches(path: string, pattern: string): boolean {
  return pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern;
}

/**
 * What an Arch PR may change (§11.3): the design, shared knowledge, what agents and tools
 * read, and the tooling in package.json. Never application code, never `.github/`.
 */
export function archMayChange(path: string, rules: ProtectionRules): boolean {
  if (path.startsWith('.github/')) return false;
  if (['README.md', 'package.json', 'package-lock.json'].includes(path)) return true;
  return rules.paths.some((pattern) => matches(path, pattern)) || Object.hasOwn(rules.fields, path);
}

/** What a change did to protected territory, compared with its base. Empty means nothing. */
export async function protectedChanges(
  base: TreeReader,
  head: TreeReader,
  changedPaths: string[],
  options: { progress: 'append' | 'frozen' },
): Promise<string[]> {
  const rules = await protectionRules(base);
  const problems = changedPaths.filter((path) => rules.paths.some((pattern) => matches(path, pattern)));
  for (const [file, pointers] of Object.entries(rules.fields)) {
    if (!changedPaths.includes(file)) continue;
    const [before, after] = [await base.read(file), await head.read(file)];
    for (const pointer of pointers) {
      if (fieldHash(before, pointer) !== fieldHash(after, pointer)) problems.push(`${file} ${pointer}`);
    }
  }
  if (changedPaths.includes('progress.txt')) {
    if (options.progress === 'frozen') problems.push('progress.txt');
    else if (!((await head.read('progress.txt')) ?? '').startsWith((await base.read('progress.txt')) ?? '')) {
      problems.push('progress.txt (only lines may be added)');
    }
  }
  return problems;
}

/** Packages in package-lock.json that don't come from the public npm registry. */
export async function lockfileProblems(tree: TreeReader): Promise<string[]> {
  const lock = parseJson(await tree.read('package-lock.json')) as { packages?: Record<string, { resolved?: string; link?: boolean }> } | undefined;
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(lock?.packages ?? {})) {
    if (name === '' || entry.link || entry.resolved === undefined) continue;
    if (!entry.resolved.startsWith('https://registry.npmjs.org/')) problems.push(`${name} resolves from ${entry.resolved}`);
  }
  return problems;
}

export interface Lock {
  version: 1;
  entries: Array<{ path: string; sha256: string } | { path: string; fields: Record<string, string> }>;
}

/** `harness/lock.json`: the hash of everything protected in a tree, so a design change shows every protected change. */
export async function computeLock(tree: TreeReader): Promise<Lock> {
  const rules = await protectionRules(tree);
  const files = new Set<string>();
  for (const pattern of rules.paths) {
    if (pattern.endsWith('/**')) for (const file of await tree.list(pattern.slice(0, -3))) files.add(file);
    else if ((await tree.read(pattern)) !== undefined || ALWAYS_PROTECTED.includes(pattern)) files.add(pattern);
  }
  files.delete('harness/lock.json');
  const entries: Lock['entries'] = [];
  for (const path of [...files].sort()) {
    const text = await tree.read(path);
    entries.push({ path, sha256: text === undefined ? 'absent' : sha256(text) });
  }
  for (const [file, pointers] of Object.entries(rules.fields).sort(([a], [b]) => a.localeCompare(b))) {
    const text = await tree.read(file);
    entries.push({ path: file, fields: Object.fromEntries(pointers.map((pointer) => [pointer, fieldHash(text, pointer)])) });
  }
  return { version: 1, entries };
}

/** Differences between a tree's `harness/lock.json` and the tree itself. */
export async function lockMismatches(tree: TreeReader): Promise<string[]> {
  const written = parseJson(await tree.read('harness/lock.json')) as Lock | undefined;
  if (!written) return ['harness/lock.json is missing'];
  const actual = await computeLock(tree);
  const key = (entry: Lock['entries'][number]) => JSON.stringify(entry);
  const writtenKeys = new Set(written.entries.map(key));
  const actualKeys = new Set(actual.entries.map(key));
  return [
    ...actual.entries.filter((e) => !writtenKeys.has(key(e))).map((e) => `${e.path}: not as listed`),
    ...written.entries.filter((e) => !actualKeys.has(key(e))).map((e) => `${e.path}: listed, but different or gone`),
  ];
}

/** Every check of every feature in the design, with the feature it belongs to. */
export async function designChecks(tree: TreeReader): Promise<Array<{ feature: string; check: Check }>> {
  const out: Array<{ feature: string; check: Check }> = [];
  for (const path of await tree.list('harness/modules')) {
    const match = /^harness\/modules\/([^/]+)\/plans\/([^/]+)\.json$/.exec(path);
    if (!match) continue;
    const plan = parseJson(await tree.read(path)) as { features?: Array<{ id: string; checks?: Check[] }> } | undefined;
    for (const feature of plan?.features ?? []) {
      for (const check of feature.checks ?? []) out.push({ feature: `${match[1]}/${match[2]}/${feature.id}`, check });
    }
  }
  return out;
}

/** The kind of a PR, from who opened it and its branch; the title must agree, and grants nothing (§11.3). */
export function prKind(author: string, branch: string, bot: string | undefined): 'Plan' | 'Fix' | 'Arch' | 'Harness' | 'Owner' {
  const byBot = bot !== undefined && author === bot;
  if (byBot && /^plan\/[^/]+\/[^/]+$/.test(branch)) return 'Plan';
  if (byBot && /^fix\/[^/]+\/[^/]+-\d+$/.test(branch)) return 'Fix';
  if (byBot && /^arch\/[^/]+$/.test(branch)) return 'Arch';
  if (!byBot && branch.startsWith('harness/upgrade-')) return 'Harness';
  return 'Owner';
}

export interface VerifyInput {
  base: TreeReader;
  head: TreeReader;
  changedPaths: string[];
  author: string;
  branch: string;
  title: string;
}

/** The `verify` job: the problems that make a PR fail, or none. */
export async function verify(input: VerifyInput): Promise<string[]> {
  const config = parseJson(await input.base.read('harness/config.json')) as { project?: { bot?: string } } | undefined;
  const kind = prKind(input.author, input.branch, config?.project?.bot);
  const problems: string[] = [];
  if (!input.title.startsWith(`${kind}: `)) problems.push(`this is a ${kind} PR (from ${input.author}, branch ${input.branch}), so its title must start with "${kind}: "`);
  if (kind === 'Plan' || kind === 'Fix') {
    for (const change of await protectedChanges(input.base, input.head, input.changedPaths, { progress: 'append' })) {
      problems.push(`changes a protected file: ${change}`);
    }
    for (const problem of await lockfileProblems(input.head)) problems.push(`package-lock.json: ${problem}`);
  }
  if (kind === 'Arch') {
    const rules = await protectionRules(input.head);
    for (const path of input.changedPaths.filter((p) => !archMayChange(p, rules))) {
      problems.push(`an Arch PR may not change ${path}: only the design, shared knowledge and tool configs`);
    }
    for (const mismatch of await lockMismatches(input.head)) problems.push(`harness/lock.json: ${mismatch}`);
  }
  return problems;
}

export interface CheckOutcome {
  id: string;
  exit: number;
  durationMs: number;
}

/** The `checks` job: init.sh, the project's checks, then those of every accepted feature, in `dir`. */
export async function runCiChecks(definitions: TreeReader, dir: string, log: (line: string) => void): Promise<CheckOutcome[]> {
  const config = parseJson(await definitions.read('harness/config.json')) as { checks?: Check[] } | undefined;
  const progress = existsSync(join(dir, 'progress.txt')) ? readFileSync(join(dir, 'progress.txt'), 'utf8') : '';
  const accepted = new Set([...progress.matchAll(/ feature\.accepted (\S+) /g)].map((m) => m[1]));
  const checks = [
    ...(config?.checks ?? []),
    ...(await designChecks(definitions)).filter((c) => accepted.has(c.feature)).map((c) => c.check),
  ].filter((c) => c.phase === 'pre-merge');
  const outcomes: CheckOutcome[] = [];
  const run = (id: string, command: string, timeoutSec: number) => {
    log(`::group::${id}: ${command}`);
    const started = Date.now();
    const result = spawnSync('bash', ['-c', command], { cwd: dir, stdio: 'inherit', timeout: timeoutSec * 1000, killSignal: 'SIGKILL' });
    log('::endgroup::');
    const exit = result.status ?? 124;
    outcomes.push({ id, exit, durationMs: Date.now() - started });
    log(`${exit === 0 ? 'passed' : `FAILED (exit ${exit})`}: ${id}`);
    return exit;
  };
  if (existsSync(join(dir, 'init.sh')) && run('init.sh', 'bash init.sh', 900) !== 0) return outcomes;
  for (const check of checks) {
    const needs = check.needs ?? [];
    // Checks that need AWS run in the harness's own sandboxes, with the view-only role: CI has none.
    if (needs.includes('aws')) {
      log(`::notice::${check.id} needs the view-only AWS role, which CI doesn't have: the harness runs it in its own sandbox`);
      continue;
    }
    if (needs.includes('tfplan') && !process.env.HARNESS_PLAN_JSON) {
      log(`::notice::${check.id} asserts on a Terraform plan, and this run made none; skipped`);
      continue;
    }
    run(check.id, check.run, check.timeoutSec ?? 600);
  }
  return outcomes;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The hash of one JSON field: canonical JSON with sorted keys, or "absent". */
export function fieldHash(text: string | undefined, pointer: string): string {
  const value = text === undefined ? undefined : resolvePointer(parseJson(text), pointer);
  return value === undefined ? 'absent' : sha256(canonicalJson(value));
}

export function resolvePointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v);
}

/** JSON, or JSON with comments and trailing commas as tsconfig allows. Undefined if absent or unreadable. */
function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripJsonComments(text));
    } catch {
      return undefined;
    }
  }
}

function stripJsonComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const string = end.exec(text)?.[0] ?? c;
      out += string;
      i += string.length - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i += 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' }, head: { type: 'string' }, 'base-sha': { type: 'string' }, 'head-sha': { type: 'string' },
      author: { type: 'string' }, branch: { type: 'string' }, title: { type: 'string' }, definitions: { type: 'string' }, dir: { type: 'string' },
    },
  });
  const summary = (text: string) => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  switch (positionals[0]) {
    case 'verify': {
      const diff = spawnSync('git', ['-C', values.head!, 'diff', '--name-only', '--no-renames', `${values['base-sha']}...${values['head-sha']}`], { encoding: 'utf8' });
      if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
      const problems = await verify({
        base: directoryReader(values.base!),
        head: directoryReader(values.head!),
        changedPaths: diff.stdout.split('\n').filter(Boolean),
        author: values.author!,
        branch: values.branch!,
        title: values.title ?? '',
      });
      for (const problem of problems) console.log(`::error::${problem}`);
      summary(problems.length ? `### verify failed\n\n${problems.map((p) => `- ${p}`).join('\n')}` : '### verify passed');
      console.log(problems.length ? `${problems.length} problem(s)` : 'verify passed');
      return problems.length ? 1 : 0;
    }
    case 'checks': {
      const outcomes = await runCiChecks(directoryReader(values.definitions!), values.dir!, (line) => console.log(line));
      const failed = outcomes.filter((o) => o.exit !== 0);
      summary(`### checks\n\n${outcomes.map((o) => `- ${o.exit === 0 ? 'passed' : `**failed** (exit ${o.exit})`}: ${o.id}`).join('\n')}`);
      return failed.length ? 1 : 0;
    }
    case 'lock':
      console.log(`${JSON.stringify(await computeLock(directoryReader(values.dir ?? '.')), null, 2)}`);
      return 0;
    default:
      console.error('usage: harness-ci.ts verify|checks|lock …');
      return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  main().then((code) => process.exit(code), (error: Error) => {
    console.log(`::error::${error.message}`);
    process.exit(1);
  });
}
