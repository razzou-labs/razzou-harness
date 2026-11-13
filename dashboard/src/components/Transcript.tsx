import { computed, defineComponent, nextTick, onMounted, onUnmounted, ref, watch, type PropType } from 'vue';
import { getJson, listen, type TranscriptItem } from '../api.ts';
import { duration } from '../format.ts';
import { Fold, Markdown } from '../ui.tsx';

type Part = { type?: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean };
/** An item, numbered as it arrives: a stable key, so a new line renders only itself. */
type Entry = { n: number; item: TranscriptItem };

/**
 * An agent's session as it happens (§14.3): what it was asked, its messages, tool calls
 * with their arguments and results, and usage. `agent` is "manager:<module>",
 * "developer:<module>/<plan>/<feature>/a<n>", or a reviewer's "<role>:<head>".
 */
export const Transcript = defineComponent({
  props: { agent: { type: String, required: true } },
  setup(props) {
    const entries = ref<Entry[]>([]);
    const box = ref<HTMLDivElement>();
    let following = true;
    let count = 0;
    const entry = (item: TranscriptItem): Entry => ({ n: count++, item });
    const load = () => {
      const agent = props.agent;
      entries.value = [];
      void getJson<TranscriptItem[]>(`/api/transcript?agent=${encodeURIComponent(agent)}`).then((list) => {
        if (agent === props.agent) entries.value = (list ?? []).map(entry);
      });
    };
    onMounted(load);
    watch(() => props.agent, load);
    const stop = listen({ transcript: (from, item) => { if (from === props.agent) entries.value = [...entries.value.slice(-999), entry(item)]; } });
    onUnmounted(stop);
    // Stays at the bottom while the owner hasn't scrolled up.
    watch(entries, () => void nextTick(() => {
      if (following && box.value) box.value.scrollTop = box.value.scrollHeight;
    }));
    const usage = computed(() => totals(entries.value.map((e) => e.item)));
    return () => (
      <div class="transcript-wrap">
        <div
          class="transcript"
          ref={box}
          onScroll={(e: Event) => {
            const el = e.currentTarget as HTMLDivElement;
            following = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {entries.value.length === 0 && <div class="text-muted">Nothing yet.</div>}
          {firstInits(entries.value).map((e) => <Item key={e.n} item={e.item} />)}
        </div>
        <div class="text-caption text-muted q-mt-xs">
          {usage.value.turns} model calls · {usage.value.written && `${usage.value.written} · `}context {usage.value.context.toLocaleString()} tokens
        </div>
      </div>
    );
  },
});

const Item = defineComponent({
  props: { item: { type: Object as PropType<TranscriptItem>, required: true } },
  setup(props) {
    return () => {
      const item = props.item;
      const message = item.message as { content?: string | Part[] } | undefined;
      switch (item.type) {
        case 'prompt': {
          // What a Developer or a reviewer was asked, which the daemon adds: its stream doesn't repeat it.
          const prompt = String(item.text ?? '');
          const title = prompt.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '') ?? 'its prompt';
          return (
            <Fold class="t-input t-prompt" label={() => `→ ${title}`}>
              <Markdown text={prompt} />
            </Fold>
          );
        }
        case 'system':
          if (item.subtype === 'init') return <div class="t-meta">session started · {String(item.model ?? '')}</div>;
          if (item.subtype === 'api_retry') {
            return (
              <div class="t-meta text-warning">
                a model call failed ({String(item.error_status ?? item.error ?? 'unknown')}): retry {String(item.attempt ?? '?')} of {String(item.max_retries ?? '?')}
              </div>
            );
          }
          return null;
        case 'assistant':
          return (
            <>
              {(Array.isArray(message?.content) ? message.content : []).map((part, i) => {
                if (part.type === 'text' && part.text) return <div key={i} class="t-text"><Markdown text={part.text} /></div>;
                if (part.type === 'tool_use') return <ToolUse key={i} name={part.name ?? '?'} input={part.input ?? {}} />;
                return null;
              })}
            </>
          );
        case 'user': {
          if (typeof message?.content === 'string') return <div class="t-input">→ {message.content}</div>;
          return (
            <>
              {(message?.content ?? []).filter((p) => p.type === 'tool_result').map((part, i) => {
                const output = resultText(part.content);
                const first = output.split('\n')[0]!.slice(0, 160) || '(empty)';
                return (
                  <Fold key={i} class={part.is_error ? 't-result bad' : 't-result'} label={() => `${part.is_error ? 'error: ' : '↳ '}${first}`}>
                    <pre>{output}</pre>
                  </Fold>
                );
              })}
            </>
          );
        }
        case 'clipped':
          // A line the daemon would not keep whole: it says so, in place of the line.
          return <div class="t-meta">{String(item.text ?? 'an item too large to show')}</div>;
        case 'result':
          return (
            <div class={item.is_error ? 't-meta text-negative' : 't-meta'}>
              finished: {String(item.subtype ?? '')} · {String(item.num_turns ?? '?')} turns
              {typeof item.duration_ms === 'number' ? ` · ${duration(item.duration_ms)}` : ''}
              {typeof item.total_cost_usd === 'number' ? ` · $${item.total_cost_usd.toFixed(2)}` : ''}
            </div>
          );
        default:
          return null;
      }
    };
  },
});

const ToolUse = defineComponent({
  props: { name: { type: String, required: true }, input: { type: Object as PropType<Record<string, unknown>>, required: true } },
  setup(props) {
    return () => {
      const short = ['command', 'file_path', 'pattern', 'url', 'description', 'path'].map((k) => props.input[k]).find((v) => typeof v === 'string');
      const name = props.name.replace(/^mcp__harness__/, '');
      const line = String(short ?? '').split('\n')[0]!.slice(0, 200);
      return (
        <Fold class="t-tool" label={() => <><b>{name}</b> <span class="mono">{line}</span></>}>
          <pre>{JSON.stringify(props.input, null, 2)}</pre>
        </Fold>
      );
    };
  },
});

/** Claude Code repeats its init at every turn of a long-lived session: only a session's first one shows. */
function firstInits(entries: Entry[]): Entry[] {
  const sessions = new Set<unknown>();
  return entries.filter(({ item }) => {
    if (item.type !== 'system' || item.subtype !== 'init') return true;
    if (sessions.has(item.session_id)) return false;
    sessions.add(item.session_id);
    return true;
  });
}

/** A tool's output, without the color codes that terminals would interpret. */
function resultText(content: unknown): string {
  const output = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { text?: unknown }) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : '';
  return output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Model calls, tokens written, and the size of the latest context. A message comes as one
 * line per part, all with its usage: each message counts once. Its output tokens are
 * counted only when it starts, so tokens written come from each turn's result, and a turn
 * under way isn't counted yet.
 */
function totals(items: TranscriptItem[]) {
  const messages = new Map<string, Record<string, number>>();
  let written = 0;
  let running = false;
  for (const item of items) {
    const message = item.message as { id?: string; usage?: Record<string, number> } | undefined;
    if (item.type === 'assistant' && message?.usage) {
      messages.set(message.id ?? String(messages.size), message.usage);
      running = true;
    }
    if (item.type === 'result') {
      written += (item.usage as Record<string, number> | undefined)?.output_tokens ?? 0;
      running = false;
    }
  }
  const last = [...messages.values()].at(-1);
  return {
    turns: messages.size,
    written: written === 0 && running ? undefined : `${written.toLocaleString()} tokens written${running ? ' before this turn' : ''}`,
    context: last ? (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) : 0,
  };
}
