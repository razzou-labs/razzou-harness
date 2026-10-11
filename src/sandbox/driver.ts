export interface SandboxSpec {
  name: string;
  image: string;
  providers: string[];
  policyFile?: string;
  /** Settings for every process in the sandbox. OpenShell ignores an image's own ENV. */
  env: Record<string, string>;
  /** The main process. Without one, OpenShell starts a login shell. */
  command?: string[];
  /** Gives the main process a terminal the owner can attach to: the Architect's. */
  tty?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SandboxStatus = 'ready' | 'stopped' | 'missing' | 'other';

export interface Follower {
  stop(): void;
  readonly done: Promise<void>;
}

/**
 * Everything the daemon does to a sandbox. The OpenShell implementation is the real one;
 * tests use a driver that runs the same scripts in local directories.
 */
export interface SandboxDriver {
  /** Where a sandbox's files are, as commands inside it see them: `/sandbox` under OpenShell. */
  rootOf(name: string): string;
  create(spec: SandboxSpec): Promise<void>;
  /** Runs a bash script in the sandbox. Resolves with its exit code; never rejects on a non-zero exit. */
  exec(name: string, script: string, options?: { input?: string; timeoutSec?: number }): Promise<ExecResult>;
  /** Calls `onLine` for each line appended to `file`, starting at line `from` (1-based), until stopped. */
  follow(name: string, file: string, from: number, onLine: (line: string) => void): Follower;
  upload(name: string, localFile: string, remoteDir: string): Promise<void>;
  download(name: string, remoteFile: string, localFile: string): Promise<void>;
  status(name: string): Promise<SandboxStatus>;
  remove(name: string): Promise<void>;
}
