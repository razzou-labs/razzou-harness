import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getJson, useLive, type TranscriptItem } from '../api.ts';
import { duration } from '../format.ts';
import { Markdown } from './Markdown.tsx';

type Part = { type?: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean };

/**
 * An agent's session as it happens (§14.3): its messages, tool calls with their
 * arguments and results, and usage. `agent` is "manager:<module>" or
 * "developer:<module>/<plan>/<feature>/a<n>".
 */
export function Transcript({ agent }: { agent: string }) {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    setItems([]);
    void getJson<TranscriptItem[]>(`/api/transcript?agent=${encodeURIComponent(agent)}`).then((list) => setItems(list ?? []));
  }, [agent]);
  useLive({ transcript: (from, item) => from === agent && setItems((list) => [...list.slice(-999), item]) });
  // Stays at the bottom while the owner hasn't scrolled up.
  useLayoutEffect(() => {
    if (following.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [items]);
  const usage = totals(items);
  return (
    <div className="transcript-wrap">
      <div
        className="transcript"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.length === 0 && <div className="muted">Nothing yet.</div>}
        {firstInits(items).map((item, i) => <Item key={i} item={item} />)}
      </div>
      <div className="muted small">
        {usage.turns} model calls · {usage.written && `${usage.written} · `}context {usage.context.toLocaleString()} tokens
      </div>
    </div>
  );
}

function Item({ item }: { item: TranscriptItem }) {
  const message = item.message as { content?: string | Part[] } | undefined;
  switch (item.type) {
    case 'system':
      if (item.subtype === 'init') return <div className="t-meta">session started · {String(item.model ?? '')}</div>;
      if (item.subtype === 'api_retry') {
        return (
          <div className="t-meta warn">
            a model call failed ({String(item.error_status ?? item.error ?? 'unknown')}): retry {String(item.attempt ?? '?')} of {String(item.max_retries ?? '?')}
          </div>
        );
      }
      return null;
    case 'assistant':
      return (
        <>
          {(Array.isArray(message?.content) ? message.content : []).map((part, i) => {
            if (part.type === 'text' && part.text) return <div key={i} className="t-text"><Markdown text={part.text} /></div>;
            if (part.type === 'tool_use') return <ToolUse key={i} name={part.name ?? '?'} input={part.input ?? {}} />;
            return null;
          })}
        </>
      );
    case 'user': {
      if (typeof message?.content === 'string') return <div className="t-input">→ {message.content}</div>;
      return (
        <>
          {(message?.content ?? []).filter((p) => p.type === 'tool_result').map((part, i) => {
            const text = resultText(part.content);
            return (
              <details key={i} className={part.is_error ? 't-result bad' : 't-result'}>
                <summary>{part.is_error ? 'error: ' : '↳ '}{text.split('\n')[0]!.slice(0, 160) || '(empty)'}</summary>
                <pre>{text}</pre>
              </details>
            );
          })}
        </>
      );
    }
    case 'result':
      return (
        <div className={item.is_error ? 't-meta bad' : 't-meta'}>
          finished: {String(item.subtype ?? '')} · {String(item.num_turns ?? '?')} turns
          {typeof item.duration_ms === 'number' ? ` · ${duration(item.duration_ms)}` : ''}
          {typeof item.total_cost_usd === 'number' ? ` · $${item.total_cost_usd.toFixed(2)}` : ''}
        </div>
      );
    default:
      return null;
  }
}

function ToolUse({ name, input }: { name: string; input: Record<string, unknown> }) {
  const short = ['command', 'file_path', 'pattern', 'url', 'description', 'path'].map((k) => input[k]).find((v) => typeof v === 'string');
  return (
    <details className="t-tool">
      <summary>
        <b>{name.replace(/^mcp__harness__/, '')}</b> <span className="mono">{String(short ?? '').split('\n')[0]!.slice(0, 200)}</span>
      </summary>
      <pre>{JSON.stringify(input, null, 2)}</pre>
    </details>
  );
}

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
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : '';
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
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
