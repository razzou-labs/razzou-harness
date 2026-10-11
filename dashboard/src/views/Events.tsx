import { useEffect, useState } from 'react';
import { getJson, useLive, type HarnessEvent } from '../api.ts';
import { clock, eventSummary, refText } from '../format.ts';

/** The live feed of events and messages, with filters (§14.1). */
export function Events() {
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [filter, setFilter] = useState('');
  const [messagesOnly, setMessagesOnly] = useState(false);
  const [open, setOpen] = useState<string>();
  useEffect(() => {
    void getJson<HarnessEvent[]>('/api/log?limit=1000').then((list) => setEvents(list ?? []));
  }, []);
  useLive({ event: (event) => setEvents((list) => (list.some((e) => e.id === event.id) ? list : [...list.slice(-1999), event])) });
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = events
    .filter((e) => !messagesOnly || e.kind === 'message')
    .filter((e) => {
      const text = `${e.type} ${refText(e.ref)} ${e.from ?? ''} ${e.to ?? ''} ${JSON.stringify(e.payload)}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .reverse();
  return (
    <div className="stack">
      <div className="row">
        <input value={filter} placeholder="Filter: a type, a module, any word" size={40} onChange={(e) => setFilter(e.target.value)} />
        <label><input type="checkbox" checked={messagesOnly} onChange={(e) => setMessagesOnly(e.target.checked)} /> messages only</label>
        <span className="muted small">{shown.length} of {events.length}</span>
      </div>
      <table className="events">
        <tbody>
          {shown.slice(0, 500).map((event) => (
            <tr key={event.id} onClick={() => setOpen(open === event.id ? undefined : event.id)}>
              <td className="mono muted">{clock(event.ts)}</td>
              <td className={event.kind === 'message' ? 'mono run' : 'mono'}>{event.type}</td>
              <td className="mono">{refText(event.ref)}</td>
              <td className="muted">{event.from ? `${event.from}${event.to ? ` → ${event.to}` : ''}` : ''}</td>
              <td>
                {eventSummary(event)}
                {open === event.id && <pre>{JSON.stringify(event.payload, null, 2)}</pre>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
