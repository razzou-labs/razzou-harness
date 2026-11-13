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
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { parseArgs } from 'node:util';

/** A tree to read: a checkout in CI, a commit in the daemon. */
export interface TreeReader {
  read(path: string): Promise<string | undefined>;
  /** Every file under a folder, as paths from the root; '' is the whole tree. */
  list(folder: string): Promise<string[]>;
}

/**
 * A folder, read as git would commit it, so that its lock agrees with the daemon's, which
 * hashes git's blobs: a symbolic link is its link's text, and in a work tree a file that
 * hasn't changed since HEAD is read as committed, before what attributes such as `eol` do
 * to a checkout.
 */
export function directoryReader(root: string): TreeReader {
  const git = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const exists = (file: string) => {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    return stat !== undefined && (stat.isFile() || stat.isSymbolicLink());
  };
  const workTree = git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true';
  // The paths that differ from HEAD, listed once; undefined when there is no HEAD to read from.
  let changed: Set<string> | undefined | null = null;
  const changedSinceHead = () => {
    if (changed === null) {
      const diff = workTree ? git(['diff', '--relative', '--name-only', '-z', '--no-renames', 'HEAD', '--']) : undefined;
      changed = diff?.status === 0 ? new Set(diff.stdout.split('\0').filter(Boolean)) : undefined;
    }
    return changed;
  };
  return {
    async read(path) {
      const file = join(root, path);
      if (!exists(file)) return undefined;
      const differing = changedSinceHead();
      if (differing && !differing.has(path)) {
        const committed = git(['cat-file', 'blob', `HEAD:./${path}`]);
        if (committed.status === 0) return committed.stdout;
      }
      return lstatSync(file).isSymbolicLink() ? readlinkSync(file) : readFileSync(file, 'utf8');
    },
    async list(folder) {
      // In a work tree, git's view: what it ignores, such as node_modules, isn't in a checkout either.
      if (workTree) {
        const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', folder || '.']);
        if (listed.status !== 0) throw new Error(`git ls-files failed in ${root}: ${listed.stderr}`);
        return listed.stdout.split('\0').filter((path) => path !== '' && exists(join(root, path)));
      }
      const start = join(root, folder);
      if (!existsSync(start)) return [];
      return (readdirSync(start, { recursive: true, encoding: 'utf8' }) as string[])
        .map((entry) => join(start, entry))
        .filter((file) => exists(file) && !relative(root, file).startsWith('.git/'))
        .map((file) => relative(root, file));
    },
  };
}

/** A commit of the repository at `root`, read with git. */
export function commitReader(root: string, rev: string): TreeReader {
  const git = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
  return {
    async read(path) {
      const blob = git(['cat-file', 'blob', `${rev}:${path}`]);
      return blob.status === 0 ? blob.stdout : undefined;
    },
    async list(folder) {
      const listed = git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', rev, '--', folder || '.']);
      if (listed.status !== 0) throw new Error(`git ls-tree failed in ${root}: ${listed.stderr}`);
      return listed.stdout.split('\0').filter(Boolean);
    },
  };
}

/**
 * Paths no Plan or Fix PR may change, in every project. Claude Code reads CLAUDE.md,
 * CLAUDE.local.md, AGENTS.md and `.claude/` in every folder, not only the root's; the
 * root's CLAUDE.md and AGENTS.md are also named, so the lock lists them even when absent.
 */
export const ALWAYS_PROTECTED = [
  'harness/**', '.github/**', 'CLAUDE.md', 'AGENTS.md', '**/.claude/**', '**/CLAUDE.md', '**/CLAUDE.local.md', '**/AGENTS.md',
  'ARCHITECTURE.md', 'init.sh', '.npmrc',
];

/**
 * Configs that decide what a tool or a test runner runs, written as code: protected whole
 * when they exist, in any folder, since a monorepo's packages each have their own.
 */
const TOOL_FILES = [
  'eslint.config.*', '.eslintrc', '.eslintrc.*', '.eslintignore', 'biome.json', 'biome.jsonc', '.prettierrc', '.prettierrc.*', '.prettierignore', 'prettier.config.*',
  'vitest.config.*', 'vitest.workspace.*', 'vite.config.*', 'jest.config.*', 'babel.config.*', '.babelrc', '.babelrc.*',
  'playwright.config.*', '.mocharc.*', 'pytest.ini', '.pytest.ini', 'tox.ini', 'conftest.py',
].map((name) => `**/${name}`);

/** What npm applies on its own when it installs: patches to packages, and its extensions. */
const INSTALL_FILES = ['patches/**', '.npm-extension.mjs', '.npm-extension.cjs'];

/** The scripts npm runs by itself during `npm ci` or `npm install`, before any check. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare'];

/** JSON configs, in every folder: protected by field, so ordinary changes stay possible. */
const JSON_FIELDS: Record<string, string[]> = {
  '**/tsconfig.json': [
    '/compilerOptions/strict', '/compilerOptions/noImplicitAny', '/compilerOptions/strictNullChecks', '/compilerOptions/skipLibCheck', '/exclude', '/include', '/extends',
  ],
  '**/package.json': [
    '/jest', '/babel', '/mocha', '/eslintConfig', '/eslintIgnore', '/prettier', '/overrides', '/patchedDependencies', '/packageExtensions', '/allowScripts',
    ...INSTALL_SCRIPTS.map((script) => `/scripts/${script}`),
  ],
};

/** TOML tables, and INI sections, that configure a test runner inside a file that holds much else. */
const TOML_TABLES: Record<string, string[]> = {
  '**/pyproject.toml': ['tool.pytest.ini_options', 'tool.pytest', 'tool.tox', 'tool.coverage'],
  '**/setup.cfg': ['tool:pytest'],
};

export interface ProtectionRules {
  /** A path matching one of these may not change at all. */
  paths: string[];
  /** These JSON fields, by file or glob, may not change. A missing field counts as a value. */
  fields: Record<string, string[]>;
  /** These TOML tables, by file or glob, may not change, compared as text. */
  tables: Record<string, string[]>;
}

const isGlob = (pattern: string) => /[*?]/.test(pattern);

/** The JSON pointers and TOML tables protected in one file, by every rule whose file or glob matches it. */
function partsOf(rules: ProtectionRules, path: string): { pointers: string[]; tables: string[] } {
  const pick = (byFile: Record<string, string[]>) => [...new Set(Object.entries(byFile).filter(([file]) => matches(path, file)).flatMap(([, names]) => names))];
  return { pointers: pick(rules.fields), tables: pick(rules.tables) };
}

/** The files among `files` protected by field or table, and the rules' named files whether or not they exist. */
function partFiles(rules: ProtectionRules, files: string[]): string[] {
  const keys = [...Object.keys(rules.fields), ...Object.keys(rules.tables)];
  const found = [...keys.filter((key) => !isGlob(key)), ...files.filter((file) => keys.some((key) => matches(file, key)))];
  return [...new Set(found)].sort((a, b) => a.localeCompare(b, 'en'));
}

/** The hashes of a file's protected fields and tables, as the lock lists them. */
export function partHashes(rules: ProtectionRules, path: string, text: string | undefined): { fields?: Record<string, string>; tables?: Record<string, string> } {
  const { pointers, tables } = partsOf(rules, path);
  return {
    ...(pointers.length > 0 ? { fields: Object.fromEntries(pointers.map((pointer) => [pointer, fieldHash(text, pointer)])) } : {}),
    ...(tables.length > 0 ? { tables: Object.fromEntries(tables.map((table) => [table, tableHash(text, table)])) } : {}),
  };
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
  const config = parseJson(await tree.read('harness/config.json')) as {
    checks?: Check[];
    protect?: { files?: string[]; jsonFields?: Record<string, string[]>; tomlTables?: Record<string, string[]> };
  } | undefined;
  const fields: Record<string, string[]> = {};
  const tables: Record<string, string[]> = {};
  const add = (into: Record<string, string[]>, file: string, names: string[]) => {
    const key = normalisePattern(file);
    into[key] = [...new Set([...(into[key] ?? []), ...names])];
  };
  for (const [file, pointers] of Object.entries(JSON_FIELDS)) add(fields, file, pointers);
  for (const [file, pointers] of Object.entries(config?.protect?.jsonFields ?? {})) add(fields, file, pointers);
  for (const [file, names] of Object.entries(TOML_TABLES)) add(tables, file, names);
  for (const [file, names] of Object.entries(config?.protect?.tomlTables ?? {})) add(tables, file, names);
  // A check written as `npm run X` is only as good as the script X, and the hooks npm runs around it, in the package.json it names.
  const checks = [...(config?.checks ?? []), ...(await designChecks(tree)).map((c) => c.check)];
  for (const { dir, script } of checks.flatMap((c) => npmScripts(c.run))) {
    add(fields, dir ? `${dir}/package.json` : 'package.json', [`/scripts/${script}`, `/scripts/pre${script}`, `/scripts/post${script}`]);
  }
  return { paths: [...ALWAYS_PROTECTED, ...TOOL_FILES, ...INSTALL_FILES, ...(config?.protect?.files ?? [])].map(normalisePattern), fields, tables };
}

/** npm's options that take the next word as their value. */
const NPM_VALUE_OPTIONS = ['--prefix', '-C', '--workspace', '-w', '--userconfig', '--globalconfig', '--loglevel'];

/** npm's options that name the folder of the package.json it runs a script from. */
const NPM_DIR_OPTIONS = ['--prefix', '-C', '--workspace', '-w'];

/**
 * npm scripts a command line runs, and the folder of the package.json that defines each, ''
 * for the root: `npm run lint`, `npm -s test`, `npm --prefix web start`, `cd web && npm test`,
 * `node --run lint`.
 */
export function npmScripts(command: string): Array<{ dir: string; script: string }> {
  const scripts: Array<{ dir: string; script: string }> = [];
  const words = command.split(/[\s;&|()<>'"`]+/);
  // A folder of the repository, from the one a command is in; '' for the root, and for one outside it.
  const within = (from: string, to: string) => {
    const dir = posix.normalize(posix.join(from, to));
    return posix.isAbsolute(to) || dir === '.' || dir === '..' || dir.startsWith('../') ? '' : dir.replace(/\/$/, '');
  };
  let cwd = '';
  for (let i = 0; i < words.length; i++) {
    if (words[i] === 'cd') cwd = words[i + 1] && words[i + 1] !== '-' ? within(cwd, words[i + 1]!) : '';
    if (words[i] === 'node' && words[i + 1] === '--run' && words[i + 2]) scripts.push({ dir: cwd, script: words[i + 2]! });
    if (words[i] === 'node' && words[i + 1]?.startsWith('--run=')) scripts.push({ dir: cwd, script: words[i + 1]!.slice('--run='.length) });
    if (words[i] !== 'npm') continue;
    let dir = cwd;
    // The next word that isn't one of npm's options, or an option's value.
    const next = (at: number) => {
      while (words[++at]?.startsWith('-')) {
        const [option, value] = words[at]!.split('=', 2) as [string, string | undefined];
        const given = value ?? (NPM_VALUE_OPTIONS.includes(option) ? words[++at] : undefined);
        if (NPM_DIR_OPTIONS.includes(option) && given !== undefined) dir = within(cwd, given);
      }
      return at;
    };
    const at = next(i);
    if (words[at] === 'run' || words[at] === 'run-script') {
      const script = words[next(at)];
      if (script) scripts.push({ dir, script });
    } else if (words[at] === 'test' || words[at] === 't') scripts.push({ dir, script: 'test' });
    else if (words[at] === 'start' || words[at] === 'stop' || words[at] === 'restart') scripts.push({ dir, script: words[at]! });
  }
  return scripts;
}

/** A pattern as written in a config: `./x` is `x`, and `dir/` is `dir/**`. */
function normalisePattern(pattern: string): string {
  const path = pattern.replace(/^(?:\.?\/)+/, '');
  // Trailing slashes are counted by hand: /\/+$/ takes quadratic time on a run of slashes before the end.
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return end === path.length ? path : `${path.slice(0, end)}/**`;
}

/** Each pattern's regular expression, made once. */
const compiled = new Map<string, RegExp>();

// Whether a path matches a protected pattern: `*` and `?` within a segment, `**` across
// segments. `**/x` is x in any folder, the root included; `dir/**` is dir and all it holds.
export function matches(path: string, pattern: string): boolean {
  let regexp = compiled.get(pattern);
  if (!regexp) {
    const source = normalisePattern(pattern).replace(/(^|\/)\*\*(\/|$)|\*|\?|[.+^${}()|[\]\\]/g, (token, before?: string, after?: string) => {
      if (before === undefined) return token === '*' ? '[^/]*' : token === '?' ? '[^/]' : `\\${token}`;
      return before && after ? '/(?:.*/)?' : before ? '(?:/.*)?' : after ? '(?:.*/)?' : '.*';
    });
    compiled.set(pattern, (regexp = new RegExp(`^${source}$`, 's')));
  }
  return regexp.test(path);
}

/**
 * What an Arch PR may change (§11.3): the design, shared knowledge, what agents and tools
 * read, and the tooling in package.json. Never application code, never `.github/`.
 */
export function archMayChange(path: string, rules: ProtectionRules): boolean {
  if (path.startsWith('.github/')) return false;
  if (['README.md', 'package.json', 'package-lock.json'].includes(path)) return true;
  return rules.paths.some((pattern) => matches(path, pattern)) || partFiles(rules, [path]).includes(path);
}

/**
 * What a change did to protected territory. The rules are `base`'s; fields, tables and
 * progress.txt are compared with `options.before`, the tree the change started from, when
 * that isn't `base`: what the base changed since is no part of the change. Empty means nothing.
 */
export async function protectedChanges(
  base: TreeReader,
  head: TreeReader,
  changedPaths: string[],
  options: { progress: 'append' | 'frozen'; before?: TreeReader },
): Promise<string[]> {
  const rules = await protectionRules(base);
  const start = options.before ?? base;
  const problems = changedPaths.filter((path) => rules.paths.some((pattern) => matches(path, pattern)));
  for (const file of partFiles(rules, changedPaths).filter((path) => changedPaths.includes(path))) {
    const [before, after] = [partHashes(rules, file, await start.read(file)), partHashes(rules, file, await head.read(file))];
    for (const [pointer, hash] of Object.entries(before.fields ?? {})) if (after.fields?.[pointer] !== hash) problems.push(`${file} ${pointer}`);
    for (const [table, hash] of Object.entries(before.tables ?? {})) if (after.tables?.[table] !== hash) problems.push(`${file} [${table}]`);
  }
  if (changedPaths.includes('progress.txt')) {
    if (options.progress === 'frozen') problems.push('progress.txt');
    else if (!((await head.read('progress.txt')) ?? '').startsWith((await start.read('progress.txt')) ?? '')) {
      problems.push('progress.txt (only lines may be added)');
    }
  }
  return problems;
}

/**
 * Packages of the head that come from somewhere other than the public npm registry, and that
 * the base doesn't have as they are: in package-lock.json, one resolved from elsewhere, a
 * link to a folder, or a patched one; without a lockfile, a `file:` or `link:` dependency of
 * package.json. What the base already has keeps working, a private registry or a workspace
 * included, and a new one comes through an Arch PR.
 */
export async function lockfileProblems(base: TreeReader, head: TreeReader): Promise<string[]> {
  type Entry = { resolved?: string; link?: boolean; patched?: unknown; integrity?: string };
  const packages = async (tree: TreeReader) => (parseJson(await tree.read('package-lock.json')) as { packages?: Record<string, Entry> } | undefined)?.packages;
  const after = await packages(head);
  const problems: string[] = [];
  if (after === undefined) {
    type Manifest = Record<string, Record<string, unknown> | undefined>;
    const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    const [was, now] = [parseJson(await base.read('package.json')) as Manifest | undefined, parseJson(await head.read('package.json')) as Manifest | undefined];
    for (const section of sections) {
      for (const [name, spec] of Object.entries(now?.[section] ?? {})) {
        if (typeof spec === 'string' && /^(?:file|link):/.test(spec) && was?.[section]?.[name] !== spec) problems.push(`${name} comes from ${spec}, which the base branch's package.json doesn't have`);
      }
    }
    return problems;
  }
  const before = (await packages(base)) ?? {};
  const pinned = (entry: Entry | undefined) => canonicalJson([entry?.resolved, entry?.link === true, entry?.patched, entry?.integrity]);
  for (const [name, entry] of Object.entries(after)) {
    if (name === '' || pinned(before[name]) === pinned(entry)) continue;
    if (entry.link) problems.push(`${name} links to ${entry.resolved}, which the base branch doesn't`);
    else if (entry.patched !== undefined) problems.push(`${name} is patched, which the base branch doesn't have`);
    else if (entry.resolved !== undefined && !entry.resolved.startsWith('https://registry.npmjs.org/')) {
      problems.push(`${name} resolves from ${entry.resolved}, which the base branch doesn't have`);
    }
  }
  return problems;
}

export interface Lock {
  version: 1;
  entries: Array<{ path: string; sha256: string } | { path: string; fields?: Record<string, string>; tables?: Record<string, string> }>;
}

/** The files of a tree protected whole: those of `files` that a pattern matches, and the root's always-protected files, present or not. */
function wholeFiles(rules: ProtectionRules, files: string[]): string[] {
  const found = new Set(files.filter((file) => rules.paths.some((pattern) => matches(file, pattern))));
  for (const path of ALWAYS_PROTECTED) if (!isGlob(path)) found.add(path);
  found.delete('harness/lock.json');
  return [...found].sort();
}

/** `harness/lock.json`: the hash of everything protected in a tree, so a design change shows every protected change. */
export async function computeLock(tree: TreeReader): Promise<Lock> {
  const rules = await protectionRules(tree);
  const all = await tree.list('');
  const entries: Lock['entries'] = [];
  for (const path of wholeFiles(rules, all)) {
    const text = await tree.read(path);
    entries.push({ path, sha256: text === undefined ? 'absent' : sha256(text) });
  }
  for (const path of partFiles(rules, all)) entries.push({ path, ...partHashes(rules, path, await tree.read(path)) });
  return { version: 1, entries };
}

/**
 * What the tripwire of the checks watches in a checkout: the files protected whole that are
 * there now, and those protected by part as they were at the start (`parts`), since a
 * package.json that a build copies into dist/ is none the checks read. What installing
 * writes, in node_modules, Terraform's modules or a Python virtual environment, is a
 * dependency's, not the project's.
 */
export function guardTargets(rules: ProtectionRules, files: string[], parts?: string[]): { whole: string[]; parts: string[] } {
  const venvs = files.filter((file) => file.endsWith('/pyvenv.cfg')).map((file) => file.slice(0, -'pyvenv.cfg'.length));
  const own = files.filter((file) => !file.split('/').some((name) => INSTALLED.includes(name)) && !venvs.some((venv) => file.startsWith(venv)));
  return { whole: wholeFiles(rules, own), parts: parts ?? partFiles(rules, own) };
}

/** The folders that installing fills, which the tripwire neither walks nor watches. */
export const INSTALLED = ['node_modules', '.terraform'];

/** The key of a file's protected parts in a checkout's state; NUL is in no path. */
export const PARTS_KEY = '\0parts';

/** The paths whose entry differs between two states of a checkout: changed, appeared or gone. */
export function guardChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...new Set([...keys].filter((key) => before.get(key) !== after.get(key)).map((key) => key.replace(PARTS_KEY, '')))].sort();
}

/** Every file and symbolic link of a checkout, as git would see them, but by walking it: the code under test controls git's view. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (folder: string) => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && !INSTALLED.includes(entry.name)) visit(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) out.push(path);
    }
  };
  visit('');
  return out;
}

/** A checkout's protected files as they are on disk: each one's hash, or link, or its protected parts' hashes. */
function checkoutState(root: string, rules: ProtectionRules, targets: { whole: string[]; parts: string[] }): Map<string, string> {
  const entry = (path: string, part: boolean) => {
    const file = join(root, path);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return `link:${readlinkSync(file)}`;
    if (!stat?.isFile()) return 'absent';
    const bytes = readFileSync(file);
    return part ? JSON.stringify(partHashes(rules, path, bytes.toString('utf8'))) : createHash('sha256').update(bytes).digest('hex');
  };
  const state = new Map<string, string>();
  for (const path of targets.whole) state.set(path, entry(path, false));
  for (const path of targets.parts) state.set(`${path}${PARTS_KEY}`, entry(path, true));
  return state;
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

/**
 * The accepted features whose checks no longer run: each superseded, as `P2/F04`, by an
 * accepted feature of the same module (v5). Their definitions stay; the superseding
 * feature's checks prove what is true now.
 */
export async function supersededFeatures(tree: TreeReader, accepted: ReadonlySet<string>): Promise<Set<string>> {
  const superseded = new Set<string>();
  for (const path of await tree.list('harness/modules')) {
    const match = /^harness\/modules\/([^/]+)\/plans\/([^/]+)\.json$/.exec(path);
    if (!match) continue;
    const plan = parseJson(await tree.read(path)) as { features?: Array<{ id: string; supersedes?: string[] }> } | undefined;
    for (const feature of plan?.features ?? []) {
      if (!accepted.has(`${match[1]}/${match[2]}/${feature.id}`)) continue;
      for (const ref of feature.supersedes ?? []) superseded.add(`${match[1]}/${ref.includes('/') ? ref : `${match[2]}/${ref}`}`);
    }
  }
  return superseded;
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

/**
 * The kind of a PR, from who opened it and its branch; the title must agree, and grants
 * nothing (§11.3). The Architect's changes to built features, `locked/<module>`, are Arch
 * PRs of their own tag (v5). The App opens no other kind: one of its on another branch is
 * `Stray`, which always fails, rather than the owner's.
 */
export function prKind(author: string, branch: string, bot: string | undefined): 'Plan' | 'Fix' | 'Arch' | 'Harness' | 'Owner' | 'Stray' {
  const byBot = bot !== undefined && author === bot;
  if (byBot && /^plan\/[^/]+\/[^/]+$/.test(branch)) return 'Plan';
  if (byBot && /^fix\/[^/]+\/[^/]+-\d+$/.test(branch)) return 'Fix';
  if (byBot && /^(?:arch|locked)\/[^/]+$/.test(branch)) return 'Arch';
  if (byBot) return 'Stray';
  if (!byBot && branch.startsWith('harness/upgrade-')) return 'Harness';
  return 'Owner';
}

export interface VerifyInput {
  base: TreeReader;
  head: TreeReader;
  /** The merge bases of the head with the base, `git merge-base --all`: the change starts from them. `[base]` when omitted. */
  mergeBases?: TreeReader[];
  /** What changed since the merge base: `git diff base...head`. */
  changedPaths: string[];
  author: string;
  branch: string;
  title: string;
}

/** What `verify` reads from the base branch's `harness/config.json`. */
interface BaseConfig {
  project?: { bot?: string };
  terraform?: { dir?: string } | null;
}

/**
 * A plan's kind, from its features' (v3 §3.1): CODE with no `infra` feature, INFRA with
 * only `infra` features, MIXED otherwise. A feature without a kind is an `app` one. The
 * same rule as the daemon's `planKind`, kept here so this file stands alone.
 */
export function planKindOf(features: Array<{ kind?: string }>): 'CODE' | 'INFRA' | 'MIXED' {
  const infra = features.filter((f) => f.kind === 'infra').length;
  return infra === 0 ? 'CODE' : infra === features.length ? 'INFRA' : 'MIXED';
}

/** A plan kind as titles write it: MIXED says what it mixes. The daemon's KIND_TAGS, kept here so this file stands alone. */
const KIND_TAGS = { CODE: 'CODE', INFRA: 'INFRA', MIXED: 'MIXED_INFRA_AND_CODE' } as const;

/**
 * The title of a PR the daemon opens (v5): `<Type>: [<TAG>] [<scope>] <title>`. A Plan PR's
 * tag is its kind, a Fix PR's what failed after the deploy, an Arch PR's what it changes:
 * a module's first design, a change to it, or built features' definitions.
 */
async function titleProblems(input: VerifyInput, kind: 'Plan' | 'Fix' | 'Arch'): Promise<string[]> {
  const [, type, tag, scope] = /^(Plan|Fix|Arch): \[([A-Z_]+)\] \[([^\]]+)\] \S/.exec(input.title) ?? [];
  const expected = (tags: string, where: string) => [`a ${kind} PR's title is "${kind}: [${tags}] [${where}] <title>", not "${input.title}"`];
  if (kind === 'Plan') {
    const [, module, plan] = /^plan\/([^/]+)\/([^/]+)$/.exec(input.branch) ?? [];
    if (type !== 'Plan' || scope !== `${module}/${plan}` || !Object.values(KIND_TAGS).includes(tag as never)) return expected('CODE|INFRA|MIXED_INFRA_AND_CODE', `${module}/${plan}`);
    return [];
  }
  if (kind === 'Fix') {
    const [, module, plan] = /^fix\/([^/]+)\/([^/]+)-\d+$/.exec(input.branch) ?? [];
    if (type !== 'Fix' || scope !== `${module}/${plan}` || !['DEPLOY_FAILED', 'VERIFY_FAILED'].includes(tag ?? '')) return expected('DEPLOY_FAILED|VERIFY_FAILED', `${module}/${plan}`);
    return [];
  }
  const [, branchType, module] = /^(arch|locked)\/([^/]+)$/.exec(input.branch) ?? [];
  if (branchType === 'locked') {
    if (type !== 'Arch' || scope !== module || tag !== 'CHANGED_LOCKED_FILES') return expected('CHANGED_LOCKED_FILES', module ?? '<module>');
    return [];
  }
  // A module's first design is the one that finds no plan of it on the base branch: later ones change it.
  const designed = (await input.base.list(`harness/modules/${module}/plans`)).some((path) => path.endsWith('.json'));
  const want = designed ? 'DESIGN_MODIFY' : 'DESIGN';
  if (type !== 'Arch' || scope !== module || tag !== want) {
    return [`this Arch PR ${designed ? `changes the design of ${module}, which main already has` : `is the first design of ${module}`}, so its title is "Arch: [${want}] [${module}] <title>", not "${input.title}"`];
  }
  return [];
}

/**
 * What a CHANGED_LOCKED_FILES PR may change (v5): the definitions of existing features in
 * their module's plan files, and the scripts its checks run; never a plan's own fields,
 * a feature added, removed, renamed or moved, nor any other file. The daemon also makes
 * sure every feature it changes is built, which it alone knows.
 */
async function lockedProblems(input: VerifyInput, module: string): Promise<string[]> {
  const problems: string[] = [];
  const plans = new RegExp(`^harness/modules/${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/plans/[^/]+\\.json$`);
  // The scripts in the module's folder: another module's would redefine that module's features too.
  const scripts = new Set([...(await checkScriptsOf(input.base, module)), ...(await checkScriptsOf(input.head, module))]);
  for (const path of input.changedPaths) {
    if (path === 'harness/lock.json') continue;
    // A plan file is held to the plan rules even when a check's command names it, as a script.
    if (!plans.test(path)) {
      if (scripts.has(path) && path.startsWith(`harness/modules/${module}/`)) continue;
      problems.push(`a CHANGED_LOCKED_FILES PR changes only the definitions of ${module}'s built features and the scripts in harness/modules/${module}/ that their checks run, not ${path}`);
      continue;
    }
    const before = parseJson(await input.base.read(path)) as { features?: Array<{ id?: string }> } | undefined;
    const after = parseJson(await input.head.read(path)) as { features?: Array<{ id?: string }> } | undefined;
    if (!before || !after) {
      problems.push(`${path}: a CHANGED_LOCKED_FILES PR neither adds nor removes a plan`);
      continue;
    }
    const { features: was = [], ...planBefore } = before;
    const { features: now = [], ...planAfter } = after;
    if (canonicalJson(planBefore) !== canonicalJson(planAfter)) problems.push(`${path}: a CHANGED_LOCKED_FILES PR changes features, not the plan's own fields`);
    if (was.map((f) => f.id).join('\n') !== now.map((f) => f.id).join('\n')) problems.push(`${path}: a CHANGED_LOCKED_FILES PR neither adds, removes, renames nor moves a feature`);
  }
  return problems;
}

/** The design files a module's checks run, as the daemon's `checkScripts` finds them in their commands. */
async function checkScriptsOf(tree: TreeReader, module: string): Promise<string[]> {
  const out: string[] = [];
  for (const path of await tree.list(`harness/modules/${module}/plans`)) {
    const plan = parseJson(await tree.read(path)) as { features?: Array<{ checks?: Array<{ run?: string }> }> } | undefined;
    for (const feature of plan?.features ?? []) {
      for (const check of feature.checks ?? []) out.push(...(check.run?.match(/harness\/modules\/[^\s'"`;|&)]+/g) ?? []));
    }
  }
  return out;
}

/**
 * The plan-kind rules of a Plan or Fix PR (v3 §3.1), from the plan file on the base branch:
 * a tag in a Plan PR's title must be the plan's kind, and a CODE plan, and its fixes after
 * the deploy, stay off the Terraform folder, so infrastructure can't reach main as code.
 * The tag grants nothing.
 */
async function planKindProblems(input: VerifyInput, config: BaseConfig | undefined): Promise<string[]> {
  const [, module, plan] = /^(?:plan\/([^/]+)\/([^/]+)|fix\/([^/]+)\/([^/]+)-\d+)$/.exec(input.branch)?.filter(Boolean) ?? [];
  if (!module || !plan) return [];
  const file = `harness/modules/${module}/plans/${plan}.json`;
  const definition = parseJson(await input.base.read(file)) as { features?: unknown } | undefined;
  if (!definition || !Array.isArray(definition.features)) return [`${file} is missing or unreadable on the base branch, so the plan's kind is unknown`];
  const kind = planKindOf(definition.features as Array<{ kind?: string }>);
  const problems: string[] = [];
  const tag = /^Plan: \[([A-Z_]+)\]/.exec(input.title)?.[1];
  // An unknown tag is the title's format problem; a known one must be the plan's kind.
  if (tag && Object.values(KIND_TAGS).includes(tag as never) && tag !== KIND_TAGS[kind]) {
    problems.push(`the title says [${tag}], but ${module}/${plan} is a ${KIND_TAGS[kind]} plan on the base branch: its features' kinds decide`);
  }
  if (kind === 'CODE' && config?.terraform && typeof config.terraform === 'object') {
    // Terraform at the root, `.` or empty, is every .tf or .tf.json file.
    const dir = (config.terraform.dir ?? 'iac').replace(/^(?:\.?\/)+/, '').replace(/\/+$/, '');
    const root = dir === '' || dir === '.';
    const touched = input.changedPaths.filter((p) => (root ? /\.tf(?:\.json)?$/.test(p) : p === dir || p.startsWith(`${dir}/`)));
    if (touched.length > 0) problems.push(`a CODE plan may not change ${root ? 'Terraform files' : `${dir}/`}: infrastructure gets plans of its own (v3 §3.1); changed: ${touched.join(', ')}`);
  }
  return problems;
}

/** The `verify` job: the problems that make a PR fail, or none. */
export async function verify(input: VerifyInput): Promise<string[]> {
  const config = parseJson(await input.base.read('harness/config.json')) as BaseConfig | undefined;
  const kind = prKind(input.author, input.branch, config?.project?.bot);
  const problems: string[] = [];
  if (kind === 'Stray') return [`the App opens pull requests from plan/, fix/, arch/ and locked/ branches only, not from ${input.branch}`];
  if (!input.title.startsWith(`${kind}: `)) problems.push(`this is a ${kind} PR (from ${input.author}, branch ${input.branch}), so its title must start with "${kind}: "`);
  else if (kind === 'Plan' || kind === 'Fix' || kind === 'Arch') problems.push(...(await titleProblems(input, kind)));
  const [start = input.base, ...others] = input.mergeBases ?? [input.base];
  if ((kind === 'Plan' || kind === 'Fix' || kind === 'Arch') && others.length > 0) {
    // `git diff base...head` shows the change from one merge base only: merging can undo what another brought, unseen.
    problems.push(`the head has ${others.length + 1} merge bases with the base branch, so merging it would change more than its diff shows`);
  }
  if (kind === 'Plan' || kind === 'Fix') {
    // The base's rules, compared with where the change started: what the base changed since is no part of it.
    for (const change of await protectedChanges(input.base, input.head, input.changedPaths, { progress: 'append', before: start })) {
      problems.push(`changes a protected file: ${change}`);
    }
    for (const problem of await lockfileProblems(start, input.head)) problems.push(`package-lock.json: ${problem}`);
  }
  if (kind === 'Plan' || kind === 'Fix') problems.push(...(await planKindProblems(input, config)));
  if (kind === 'Arch') {
    // The base's rules, as for every PR: what its head protects opens nothing to the PR itself.
    const locked = /^locked\/([^/]+)$/.exec(input.branch)?.[1];
    if (locked) {
      // Stricter than a design's: built features' definitions and their scripts only.
      problems.push(...(await lockedProblems(input, locked)));
    } else {
      const rules = await protectionRules(input.base);
      for (const path of input.changedPaths.filter((p) => !archMayChange(p, rules))) {
        problems.push(`an Arch PR may not change ${path}: only the design, shared knowledge and tool configs`);
      }
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
  const accepted = new Set([...progress.matchAll(/ feature\.accepted (\S+) /g)].map((m) => m[1]!));
  // A feature superseded by an accepted one keeps its definition, but its checks no longer run (v5).
  const superseded = await supersededFeatures(definitions, accepted);
  const checks = [
    ...(config?.checks ?? []),
    ...(await designChecks(definitions)).filter((c) => accepted.has(c.feature) && !superseded.has(c.feature)).map((c) => c.check),
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
  // A tripwire: what init.sh or a check runs, such as a `prepare` script, could rewrite a protected file in the checkout,
  // which verify judged as committed, and make a check pass. Taken before anything runs, compared after each step.
  const rules = await protectionRules(definitions);
  const start = guardTargets(rules, walkFiles(dir));
  const before = checkoutState(dir, rules, start);
  const tripped = () => {
    const changed = guardChanges(before, checkoutState(dir, rules, guardTargets(rules, walkFiles(dir), start.parts)));
    if (changed.length === 0) return false;
    log(`::error::the code under test changed protected files while the checks ran: ${changed.join(', ')}`);
    outcomes.push({ id: 'protected-files', exit: 1, durationMs: 0 });
    return true;
  };
  if (existsSync(join(dir, 'init.sh')) && (run('init.sh', 'bash init.sh', 900) !== 0 || tripped())) return outcomes;
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
    if (tripped()) return outcomes;
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

/**
 * The hash of one TOML table, or INI section, as raw text, or "absent": the block of each
 * header that is the table or under it, from the header to the next one, and a block above
 * it that reaches into it with a dotted key, as `[tool]` then `pytest.ini_options.addopts = …`.
 * Raw text needs no TOML parser, and any change to the table, a comment's too, counts.
 */
export function tableHash(text: string | undefined, table: string): string {
  if (text === undefined) return 'absent';
  const bare = (s: string) => s.replace(/["'\s]/g, '');
  const blocks: Array<{ name: string; text: string }> = [{ name: '', text: '' }];
  for (const line of text.split('\n')) {
    const header = /^\s*\[\[?([^[\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) blocks.push({ name: bare(header[1]!), text: '' });
    blocks.at(-1)!.text += `${line}\n`;
  }
  const picked = blocks.filter(({ name, text: block }) => {
    if (name === table || name.startsWith(`${table}.`)) return true;
    if (name !== '' && !table.startsWith(`${name}.`)) return false;
    const key = (name === '' ? table : table.slice(name.length + 1)).split('.')[0]!;
    return block.split('\n').some((line) => bare(line).startsWith(`${key}.`) || bare(line).startsWith(`${key}=`));
  });
  // Without the blank lines that end a block: a table added after it leaves it as it was.
  return picked.length === 0 ? 'absent' : sha256(picked.map((b) => `${b.text.trimEnd()}\n`).join(''));
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

/** JSON with object keys sorted at every level. The order is English's, whatever the machine's locale, so CI and the owner's machine agree. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, 'en')))
      : v);
}

/** JSON, or JSON with comments and trailing commas as tsconfig allows. Undefined if absent or unreadable. */
export function parseJson(text: string | undefined): unknown {
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
      // A string, escapes and all, copied as it is. Scanned once: an unclosed one runs to
      // the end, and JSON.parse refuses it, where a regex tried at each quote would rescan.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
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
      // NUL-separated: otherwise git quotes a path with unusual bytes, and no pattern matches the quoted form.
      const diff = spawnSync('git', ['-C', values.head!, 'diff', '-z', '--name-only', '--no-renames', `${values['base-sha']}...${values['head-sha']}`], { encoding: 'utf8', maxBuffer: 1 << 30 });
      if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
      const bases = spawnSync('git', ['-C', values.head!, 'merge-base', '--all', values['base-sha']!, values['head-sha']!], { encoding: 'utf8' });
      if (bases.status !== 0) throw new Error(`git merge-base failed: ${bases.stderr}`);
      const problems = await verify({
        base: directoryReader(values.base!),
        head: directoryReader(values.head!),
        mergeBases: bases.stdout.split('\n').filter(Boolean).map((sha) => commitReader(values.head!, sha)),
        changedPaths: diff.stdout.split('\0').filter(Boolean),
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
      // The checks run as main defines them, so a PR can't weaken its own; a CHANGED_LOCKED_FILES PR, the App's on
      // locked/<module>, exists to change built features' checks, and they run as it defines them, which the owner merges (v5).
      const base = directoryReader(values.definitions!);
      const config = parseJson(await base.read('harness/config.json')) as BaseConfig | undefined;
      const locked = (values.branch ?? '').startsWith('locked/') && prKind(values.author ?? '', values.branch ?? '', config?.project?.bot) === 'Arch';
      const outcomes = await runCiChecks(locked ? directoryReader(values.dir!) : base, values.dir!, (line) => console.log(line));
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
