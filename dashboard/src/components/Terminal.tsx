import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { defineComponent, onMounted, onUnmounted, ref } from 'vue';
import { COPY_WINDOW_MS, copiedText, copiesSelection } from '../clipboard.ts';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * A terminal in the page (§14.3): an Architect's (`module`), or a shell in a sandbox
 * (`sandbox`). Keys go to the daemon over a WebSocket, as `{"i": keys}`; size changes as
 * `{"cols", "rows"}`. While the program in it uses the mouse, a drag with Shift held
 * selects, or with Option on a Mac.
 */
export const Terminal = defineComponent({
  props: { module: String, sandbox: String },
  setup(props) {
    const element = ref<HTMLDivElement>();
    let cleanup = () => {};
    onMounted(() => {
      const box = element.value!;
      const term = new XTerm({ fontSize: 13, cursorBlink: true, scrollback: 5000, theme: { background: '#141413', foreground: '#ececea' }, macOptionClickForcesSelection: true });
      // When the owner last pressed a key or a mouse button here, or released one pressed here.
      let used = 0;
      let pressed = false;
      const press = (event: MouseEvent) => {
        pressed = box.contains(event.target as Node);
        if (pressed) used = Date.now();
      };
      const release = () => {
        if (pressed) used = Date.now();
        pressed = false;
      };
      window.addEventListener('mousedown', press, true);
      window.addEventListener('mouseup', release, true);
      // Ctrl+C and Ctrl+Shift+C copy the selection; the next Ctrl+C, with nothing selected, interrupts.
      term.attachCustomKeyEventHandler((event) => {
        if (event.type === 'keydown') used = Date.now();
        if (!copiesSelection(event, term.hasSelection(), MAC)) return true;
        if (event.type === 'keydown') {
          event.preventDefault();
          navigator.clipboard.writeText(term.getSelection()).then(() => term.clearSelection(), () => {});
        }
        return false;
      });
      // Claude Code copies what the owner selects in it, and `/copy`, with OSC 52. The
      // Architect's terminal writes it to the clipboard while the owner is at it, and never
      // tells a program what the clipboard holds. A shell's programs can't set it at all.
      if (props.module) {
        term.parser.registerOscHandler(52, (data) => {
          const copied = copiedText(data);
          if (copied !== undefined && Date.now() - used < COPY_WINDOW_MS) navigator.clipboard.writeText(copied).catch(() => {});
          return true;
        });
      }
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(box);
      fit.fit();
      const target = props.module ? `module=${encodeURIComponent(props.module)}` : `sandbox=${encodeURIComponent(props.sandbox ?? '')}`;
      const socket = new WebSocket(`ws://${location.host}/api/terminal?${target}&cols=${term.cols}&rows=${term.rows}`);
      socket.onmessage = (message) => term.write(String(message.data));
      socket.onclose = (event) => term.write(`\r\n\x1b[2m[${event.reason || 'disconnected'}]\x1b[0m\r\n`);
      const keys = term.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ i: data })));
      const resized = term.onResize(({ cols, rows }) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ cols, rows })));
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(box);
      term.focus();
      cleanup = () => {
        window.removeEventListener('mousedown', press, true);
        window.removeEventListener('mouseup', release, true);
        observer.disconnect();
        keys.dispose();
        resized.dispose();
        socket.close();
        term.dispose();
      };
    });
    onUnmounted(() => cleanup());
    return () => <div class="terminal" ref={element} />;
  },
});
