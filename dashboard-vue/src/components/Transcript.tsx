import { computed, defineComponent, nextTick, onMounted, onUnmounted, ref, watch, type PropType } from 'vue';
import { getJson, listen, type TranscriptItem } from '../api.ts';
import { duration } from '../format.ts';
import { Markdown } from '../ui.tsx';

type Part = { type?: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean };

/**
 * An agent's session as it happens (§14.3): what it was asked, its messages, tool calls
 * with their arguments and results, and usage. `agent` is "manager:<module>",
 * "developer:<module>/<plan>/<feature>/a<n>", or a reviewer's "<role>:<head>".
 */
export const Transcript = defineComponent({
  props: { agent: { type: String, required: true } },
  setup(props) {
    const items = ref<TranscriptItem[]>([]);
    const box = ref<HTMLDivElement>();
    let following = true;
    const load = () => {
      items.value = [];
      void getJson<TranscriptItem[]>(`/api/transcript?agent=${encodeURIComponent(props.agent)}`).then((list) => (items.value = list ?? []));
    };
    onMounted(load);
    watch(() => props.agent, load);
    const stop = listen({ transcript: (from, item) => { if (from === props.agent) items.value = [...items.value.slice(-999), item]; } });
    onUnmounted(stop);
    // Stays at the bottom while the owner hasn't scrolled up.
    watch(items, () => void nextTick(() => {
      if (following && box.value) box.value.scrollTop = box.value.scrollHeight;
    }));
    const usage = computed(() => totals(items.value));
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
          {items.value.length === 0 && <div class="text-grey-7">Nothing yet.</div>}
          {firstInits(items.value).map((item, i) => <Item key={i} item={item} />)}
        </div>
        <div class="text-caption text-grey-7 q-mt-xs">
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
            <details class="t-input t-prompt">
              <summary>→ {title}</summary>
              <Markdown text={prompt} />
            </details>
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
                return (
                  <details key={i} class={part.is_error ? 't-result bad' : 't-result'}>
                    <summary>{part.is_error ? 'error: ' : '↳ '}{output.split('\n')[0]!.slice(0, 160) || '(empty)'}</summary>
                    <pre>{output}</pre>
                  </details>
                );
              })}
            </>
          );
        }
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
      return (
        <details class="t-tool">
          <summary>
            <b>{props.name.replace(/^mcp__harness__/, '')}</b> <span class="mono">{String(short ?? '').split('\n')[0]!.slice(0, 200)}</span>
          </summary>
          <pre>{JSON.stringify(props.input, null, 2)}</pre>
        </details>
      );
    };
  },
});

/** Claude Code repeats its init at every turn of a long-lived session: only a session's first one shows. */
function firstInits(items: TranscriptItem[]): TranscriptItem[] {
  const sessions = new Set<unknown>();
  return items.filter((item) => {
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
