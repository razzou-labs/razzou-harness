import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

/**
 * A terminal in the page (§14.3): an Architect's (`module`), or a shell in a sandbox
 * (`sandbox`). Keys go to the daemon over a WebSocket, as `{"i": keys}`; size changes as
 * `{"cols", "rows"}`.
 */
export function Terminal({ module, sandbox }: { module?: string; sandbox?: string }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const term = new XTerm({ fontSize: 13, cursorBlink: true, scrollback: 5000, theme: theme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element.current!);
    fit.fit();
    const target = module ? `module=${encodeURIComponent(module)}` : `sandbox=${encodeURIComponent(sandbox ?? '')}`;
    const socket = new WebSocket(`ws://${location.host}/api/terminal?${target}&cols=${term.cols}&rows=${term.rows}`);
    socket.onmessage = (message) => term.write(String(message.data));
    socket.onclose = (event) => term.write(`\r\n\x1b[2m[${event.reason || 'disconnected'}]\x1b[0m\r\n`);
    const keys = term.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ i: data })));
    const resized = term.onResize(({ cols, rows }) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ cols, rows })));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element.current!);
    term.focus();
    return () => {
      observer.disconnect();
      keys.dispose();
      resized.dispose();
      socket.close();
      term.dispose();
    };
  }, [module, sandbox]);
  return <div className="terminal" ref={element} />;
}

/** Always dark: Claude Code in the Architect's sandbox draws for a dark terminal. */
function theme() {
  return { background: '#141413', foreground: '#ececea' };
}
