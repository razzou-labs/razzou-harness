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
  /** Labels on the sandbox, which OpenShell's list shows: the project it belongs to. */
  labels?: Record<string, string>;
  /** Caps on what it may use of the machine, in OpenShell's quantities: `1500m` CPUs, `4096Mi` of memory. */
  cpu?: string;
  memory?: string;
}

/** The label that tells which project a sandbox belongs to: names are hashes, and every project shares the gateway. */
export const PROJECT_LABEL = 'harness.project';

/** A sandbox as the gateway lists it, whichever project made it. */
export interface SandboxInfo {
  name: string;
  /** OpenShell's word for its state: Ready, Provisioning, Stopped, Error… */
  phase: string;
  createdAt?: string;
  labels: Record<string, string>;
}

/** Whether the CLI reaches the gateway, and its version; `problem` says why not. */
export interface GatewayStatus {
  status: string;
  version?: string;
  problem?: string;
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
  /**
   * Where a sandbox stands. `missing` only when the gateway says it has no such sandbox: a
   * gateway that doesn't answer throws, since a sandbox nobody could ask about isn't gone.
   */
  status(name: string): Promise<SandboxStatus>;
  /** Starts a stopped sandbox again, its files as they were: what a reboot of the machine leaves. */
  start(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Every sandbox on the gateway, this project's and any other's. */
  list(): Promise<SandboxInfo[]>;
  /** The sandbox's last `lines` log lines, among them the network requests its policy refused. */
  logs(name: string, lines: number): Promise<string>;
  gateway(): Promise<GatewayStatus>;
  /** The names of the providers on the gateway: those holding credentials sandboxes may use. */
  providers(): Promise<string[]>;
}
