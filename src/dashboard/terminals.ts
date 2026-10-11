/** What the dashboard needs from node-pty, so tests can stand in for it. */
export interface Pty {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnPty = (file: string, args: string[], size: Size) => Pty;

export interface Size {
  cols: number;
  rows: number;
}

/** A browser terminal: it receives output, and is told when its terminal is gone. */
export interface Viewer {
  send(data: string): void;
  close(reason: string): void;
}

/**
 * node-pty is an optional dependency, because it compiles at install. Without it, the
 * dashboard has no terminals, and `harness attach` still works.
 */
export async function loadPty(): Promise<SpawnPty | undefined> {
  try {
    const pty = await import('node-pty');
    return (file, args, size) => pty.spawn(file, args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, env: process.env });
  } catch {
    return undefined;
  }
}

/** Detaching from `openshell sandbox connect` leaves the sandbox's own terminal running. */
const DETACH = '\x10\x11';
/** Enough of the screen to show a newcomer, until the program redraws it. */
const SCROLLBACK = 256 * 1024;

interface Shared {
  pty: Pty;
  viewers: Set<Viewer>;
  output: string;
  ready: Promise<void>;
}

/**
 * The owner's terminals in the dashboard (§14.3). An Architect's terminal is one
 * `openshell sandbox connect` shared by every viewer, so the daemon can type into it too.
 * A shell is a `bash -l` of its own in any harness sandbox.
 */
export class Terminals {
  private readonly shared = new Map<string, Shared>();
  private readonly shells = new Set<Pty>();
  private readonly spawn: SpawnPty | undefined;

  constructor(spawn: SpawnPty | undefined) {
    this.spawn = spawn;
  }

  get available(): boolean {
    return this.spawn !== undefined;
  }

  /** Shows the Architect's terminal to a viewer. The returned functions forward its keys and size, and detach it. */
  attach(sandbox: string, viewer: Viewer, size: Size): { input: (data: string) => void; resize: (size: Size) => void; detach: () => void } {
    const session = this.connect(sandbox, size);
    session.viewers.add(viewer);
    if (session.output) viewer.send(session.output);
    // A full-screen program redraws on a size change: nudge it, so the newcomer sees a whole screen.
    session.pty.resize(size.cols, Math.max(2, size.rows - 1));
    setTimeout(() => session.pty.resize(size.cols, size.rows), 100);
    return {
      input: (data) => session.pty.write(data),
      resize: ({ cols, rows }) => session.pty.resize(cols, rows),
      detach: () => {
        session.viewers.delete(viewer);
        if (session.viewers.size === 0) this.disconnect(sandbox);
      },
    };
  }

  /** Whether the owner is looking at the Architect's terminal. */
  watched(sandbox: string): boolean {
    return (this.shared.get(sandbox)?.viewers.size ?? 0) > 0;
  }

  /**
   * Types a prompt into the Architect's terminal and submits it. Its hook then shows the
   * Architect what the harness has written to its inbox (§9.6).
   */
  async prompt(sandbox: string, text: string): Promise<void> {
    const session = this.connect(sandbox, { cols: 120, rows: 40 });
    await session.ready;
    session.pty.write(text);
    // Sent apart, Enter submits the text instead of becoming part of it.
    await wait(500);
    session.pty.write('\r');
    await wait(1000);
    if (session.viewers.size === 0) this.disconnect(sandbox);
  }

  /** A login shell in any harness sandbox, for one viewer. */
  shell(sandbox: string, viewer: Viewer, size: Size): { input: (data: string) => void; resize: (size: Size) => void; detach: () => void } {
    const pty = this.spawn!('openshell', ['sandbox', 'exec', '-n', sandbox, '--tty', '--', 'bash', '-l'], size);
    this.shells.add(pty);
    pty.onData((data) => viewer.send(data));
    pty.onExit(() => {
      this.shells.delete(pty);
      viewer.close('the shell ended');
    });
    return {
      input: (data) => pty.write(data),
      resize: ({ cols, rows }) => pty.resize(cols, rows),
      detach: () => {
        this.shells.delete(pty);
        kill(pty);
      },
    };
  }

  /** Detaches everything, as the daemon stops: sandboxes keep running. */
  closeAll(): void {
    for (const sandbox of [...this.shared.keys()]) this.disconnect(sandbox);
    for (const pty of this.shells) kill(pty);
    this.shells.clear();
  }

  private connect(sandbox: string, size: Size): Shared {
    const existing = this.shared.get(sandbox);
    if (existing) return existing;
    if (!this.spawn) throw new Error('terminals need node-pty, which failed to install: use `harness attach`');
    const pty = this.spawn('openshell', ['sandbox', 'connect', sandbox], size);
    let started: () => void = () => {};
    // The first output means the connection is up. A silent one gets a few seconds.
    const ready = new Promise<void>((resolve) => {
      started = resolve;
      setTimeout(resolve, 3000).unref?.();
    });
    const session: Shared = { pty, viewers: new Set(), output: '', ready };
    pty.onData((data) => {
      started();
      session.output = (session.output + data).slice(-SCROLLBACK);
      for (const viewer of session.viewers) viewer.send(data);
    });
    pty.onExit(() => {
      if (this.shared.get(sandbox) === session) this.shared.delete(sandbox);
      for (const viewer of session.viewers) viewer.close('the connection to the sandbox ended');
    });
    this.shared.set(sandbox, session);
    return session;
  }

  private disconnect(sandbox: string): void {
    const session = this.shared.get(sandbox);
    if (!session) return;
    this.shared.delete(sandbox);
    session.pty.write(DETACH);
    // `connect` exits by itself once detached; this is in case it doesn't.
    setTimeout(() => kill(session.pty), 2000).unref?.();
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A process that already exited can't be killed, and that's fine. */
function kill(pty: Pty): void {
  try {
    pty.kill();
  } catch {
    // gone already
  }
}
