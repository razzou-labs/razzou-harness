/** What `copiesSelection` reads of a keyboard event. */
export interface Key {
  keyCode: number;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** The key code xterm.js turns into Ctrl+C's interrupt when Ctrl is down. */
const C = 67;

/**
 * Whether a key copies a terminal's selection instead of reaching the program in it. Away
 * from a Mac, xterm.js sends Ctrl+C to the program as an interrupt, and leaves Ctrl+Shift+C
 * to the browser, which opens its inspector: so both copy while text is selected, and
 * Ctrl+C with nothing selected still interrupts. On a Mac, Cmd+C copies already, through
 * the browser's copy event, and Ctrl+C stays the program's.
 */
export function copiesSelection(key: Key, selected: boolean, mac: boolean): boolean {
  return !mac && selected && key.ctrlKey && !key.altKey && !key.metaKey && key.keyCode === C;
}

/** How long after the owner's last key or click in a terminal a program there may set the clipboard. */
export const COPY_WINDOW_MS = 5000;

/**
 * The text a program copies with OSC 52, `ESC ] 52 ; <targets> ; <base64> BEL`, from what
 * follows `52;`. Claude Code copies its own selections that way, and `/copy`. A query, `?`,
 * which asks what the clipboard holds, gives nothing, as do an empty payload, which would
 * clear it, and one that isn't base64 of UTF-8 text.
 */
export function copiedText(data: string): string | undefined {
  const payload = data.slice(data.indexOf(';') + 1);
  if (payload === '' || payload === '?') return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}
