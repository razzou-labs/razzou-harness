import { execFile, type ExecFileOptions } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Quotes a string for a POSIX shell, so it can be embedded in a `bash -c` script. */
export function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** JSON with object keys sorted at every level, so equal values hash the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions extends ExecFileOptions {
  input?: string;
}

/** Runs a program without a shell and resolves with its exit code and output, never rejecting on a non-zero exit. */
export function run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { input, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', ...rest }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    // A program may exit without reading its input; that's not an error.
    child.stdin?.on('error', () => {});
    if (input === undefined) child.stdin?.end();
    else child.stdin?.end(input);
  });
}

/** Like run(), but throws with the command's stderr when it exits non-zero. */
export async function runOk(file: string, args: string[], options: RunOptions = {}): Promise<string> {
  const result = await run(file, args, options);
  if (result.code !== 0) {
    throw new Error(`${file} ${args.join(' ')} exited ${result.code}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

/** Shortens text to at most `max` characters, cutting at a space when one is near, and marks the cut with "…". */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

export function tail(text: string, chars = 2000): string {
  return text.length <= chars ? text : `…${text.slice(-chars)}`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
