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
