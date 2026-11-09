import { matCheck, matContentCopy } from '@quasar/extras/material-icons';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Dialog, Notify, QBadge, QBtn, QInput } from 'quasar';
import { computed, defineComponent, ref, type FunctionalComponent, type PropType, type Ref } from 'vue';
import type { Outcome } from './api.ts';
import { isGithubLink, tone } from './format.ts';

/** Quasar's color for a status word, from the tones the first dashboard gave its classes. */
const COLORS: Record<string, string> = { ok: 'positive', bad: 'negative', warn: 'warning', muted: 'grey-6', run: 'primary' };
export const colorOf = (status: string): string => COLORS[tone(status)] ?? 'primary';
/** The text class of a tone, for words in a sentence. */
export const textOf = (status: string): string => `text-${colorOf(status)}`;

/** `v-model` spelled out for TSX: the value, and what updates it. */
export function model<T>(value: Ref<T>): { modelValue: T; 'onUpdate:modelValue': (next: T) => void } {
  return {
    modelValue: value.value,
    'onUpdate:modelValue': (next: T) => {
      value.value = next;
    },
  };
}

/** The same for a text field, which hands back a number for type="number", and null once cleared. */
export function text(value: Ref<string>): { modelValue: string; 'onUpdate:modelValue': (next: string | number | null) => void } {
  return {
    modelValue: value.value,
    'onUpdate:modelValue': (next) => {
      value.value = next === null ? '' : String(next);
    },
  };
}

/** The owner's yes or no, in a dialog. */
export function confirm(message: string, ok = 'Yes'): Promise<boolean> {
  return new Promise((resolve) => {
    Dialog.create({ message, cancel: { flat: true, noCaps: true }, ok: { label: ok, noCaps: true, color: 'primary' }, persistent: true })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false));
  });
}

export const Badge: FunctionalComponent<{ status: string; label?: string }> = (props) => (
  <QBadge class="status" color={colorOf(props.status)} label={props.label ?? props.status.replace(/_/g, ' ')} />
);

/** A link to GitHub, or plain text for anything else: agents choose the rest of the text. */
export const GithubLink: FunctionalComponent<{ url?: string | undefined }> = (props, { slots }) =>
  isGithubLink(props.url) ? <a href={props.url} target="_blank" rel="noopener noreferrer">{slots.default?.()}</a> : <span>{slots.default?.()}</span>;

/**
 * A button for an owner action. Beside it, why the daemon refused, or what went wrong
 * beside an action that was done; with `toast`, the same in a notification, for the header.
 */
export const Action = defineComponent({
  props: {
    label: { type: String, required: true },
    run: { type: Function as PropType<() => Promise<Outcome>>, required: true },
    danger: Boolean,
    toast: Boolean,
    icon: String,
    flat: Boolean,
  },
  setup(props) {
    const busy = ref(false);
    const error = ref<string>();
    const click = async () => {
      busy.value = true;
      const result = await props.run();
      busy.value = false;
      const problem = result.done ? result.warning : result.error ?? 'refused';
      if (props.toast) {
        if (problem) Notify.create({ type: result.done ? 'warning' : 'negative', message: problem, timeout: 8000 });
      } else {
        error.value = problem;
      }
    };
    return () => (
      <span class="action">
        <QBtn
          label={props.label}
          icon={props.icon}
          color={props.danger ? 'negative' : 'primary'}
          outline={!props.flat}
          flat={props.flat}
          noCaps
          dense
          padding="2px 10px"
          loading={busy.value}
          onClick={() => void click()}
        />
        {error.value && <span class="text-negative text-caption q-ml-sm">{error.value}</span>}
      </span>
    );
  },
});

/** A text box and a button. The text stays until the action is done. */
export const Reply = defineComponent({
  props: {
    label: { type: String, required: true },
    send: { type: Function as PropType<(text: string) => Promise<Outcome>>, required: true },
    placeholder: String,
    optional: Boolean,
  },
  setup(props) {
    const value = ref('');
    const busy = ref(false);
    const error = ref<string>();
    const go = async () => {
      busy.value = true;
      const result = await props.send(value.value.trim());
      busy.value = false;
      if (result.done) value.value = '';
      error.value = result.done ? undefined : result.error ?? 'refused: the state changed meanwhile';
    };
    return () => (
      <div class="reply">
        <QInput {...text(value)} type="textarea" autogrow outlined dense label={props.placeholder} />
        <div class="row items-center q-gutter-sm q-mt-xs">
          <QBtn label={props.label} color="primary" noCaps dense padding="2px 12px" loading={busy.value} disable={!props.optional && value.value.trim() === ''} onClick={() => void go()} />
          {error.value && <span class="text-negative text-caption">{error.value}</span>}
        </div>
      </div>
    );
  },
});

/** A command for the owner's terminal, with a button that puts it on the clipboard. */
export const Command = defineComponent({
  props: { text: { type: String, required: true } },
  setup(props) {
    const copied = ref(false);
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(props.text);
      } catch {
        // Over plain http on a LAN address there is no clipboard API: the old way still works.
        const area = document.createElement('textarea');
        area.value = props.text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      copied.value = true;
      window.setTimeout(() => (copied.value = false), 1500);
    };
    return () => (
      <span class="command">
        <code>{props.text}</code>
        <QBtn flat dense noCaps size="sm" icon={copied.value ? matCheck : matContentCopy} label={copied.value ? 'Copied' : 'Copy'} onClick={() => void copy()} />
      </span>
    );
  },
});

// Links that agents write open in a new tab, and never with access to this page.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Agent-written Markdown, through a sanitizer: agents can write HTML (§14.4). Without
 * styles too, which the page allows inline: agent text could cover or hide the rest of
 * Needs you, a warning included.
 */
export const Markdown = defineComponent({
  props: { text: { type: String, required: true } },
  setup(props) {
    const html = computed(() => DOMPurify.sanitize(marked.parse(props.text, { async: false, gfm: true }), { FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] }));
    return () => <div class="markdown" innerHTML={html.value} />;
  },
});
