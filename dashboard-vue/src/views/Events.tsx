import { QCheckbox, QInput, QMarkupTable } from 'quasar';
import { computed, defineComponent, onMounted, onUnmounted, ref } from 'vue';
import { getJson, listen, type HarnessEvent } from '../api.ts';
import { clock, eventSummary, refText } from '../format.ts';
import { model, text } from '../ui.tsx';

/** The live feed of events and messages, with filters (§14.1). */
export const Events = defineComponent({
  setup() {
    const events = ref<HarnessEvent[]>([]);
    const filter = ref('');
    const messagesOnly = ref(false);
    const open = ref<string>();
    onMounted(() => void getJson<HarnessEvent[]>('/api/log?limit=1000').then((list) => (events.value = list ?? [])));
    const stop = listen({ event: (event) => { if (!events.value.some((e) => e.id === event.id)) events.value = [...events.value.slice(-1999), event]; } });
    onUnmounted(stop);
    const shown = computed(() => {
      const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
      return events.value
        .filter((e) => !messagesOnly.value || e.kind === 'message')
        .filter((e) => {
          const text = `${e.type} ${refText(e.ref)} ${e.from ?? ''} ${e.to ?? ''} ${JSON.stringify(e.payload)}`.toLowerCase();
          return words.every((w) => text.includes(w));
        })
        .reverse();
    });
    return () => (
      <div class="column q-gutter-md">
        <div class="row items-center q-gutter-md">
          <QInput {...text(filter)} dense outlined clearable label="Filter: a type, a module, any word" style="min-width: 340px" />
          <QCheckbox {...model(messagesOnly)} label="messages only" dense />
          <span class="text-caption text-grey-7">{shown.value.length} of {events.value.length}</span>
        </div>
        <QMarkupTable flat bordered dense wrapCells class="events">
          <tbody>
            {shown.value.slice(0, 500).map((event) => (
              <tr key={event.id} class="cursor-pointer" onClick={() => (open.value = open.value === event.id ? undefined : event.id)}>
                <td class="mono text-grey-7">{clock(event.ts)}</td>
                <td class={event.kind === 'message' ? 'mono text-primary' : 'mono'}>{event.type}</td>
                <td class="mono">{refText(event.ref)}</td>
                <td class="text-grey-7">{event.from ? `${event.from}${event.to ? ` → ${event.to}` : ''}` : ''}</td>
                <td>
                  {eventSummary(event)}
                  {open.value === event.id && <pre>{JSON.stringify(event.payload, null, 2)}</pre>}
                </td>
              </tr>
            ))}
          </tbody>
        </QMarkupTable>
      </div>
    );
  },
});
