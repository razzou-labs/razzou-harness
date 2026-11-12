import { Notify } from 'quasar';
import { ref, watch } from 'vue';
import { arrivals, listNeeds, needTitle, type Need, type Told } from '../../src/dashboard/needs.ts';
import { harness } from './api.ts';

const KEY = 'harness.notify';

/** Whether this browser can show notifications at all: the page is served on localhost, which counts as secure. */
export const canNotify = typeof Notification !== 'undefined';

/** The owner's choice in this browser, kept across reloads; it counts only while the browser still allows it. */
export const notifying = ref(canNotify && localStorage.getItem(KEY) === 'on' && Notification.permission === 'granted');

/**
 * Switches the notifications of this browser. Turning them on asks the browser, which
 * asks the owner once; a refusal is the browser's to undo, in its settings for the page.
 */
export async function toggleNotifications(): Promise<void> {
  if (notifying.value) {
    notifying.value = false;
    localStorage.setItem(KEY, 'off');
    return;
  }
  if (!canNotify) return void Notify.create({ type: 'warning', message: 'This browser has no notifications.' });
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') {
    return void Notify.create({ type: 'warning', timeout: 8000, message: "The browser refuses notifications from this page: allow them in its settings for the page, then switch them on here." });
  }
  notifying.value = true;
  localStorage.setItem(KEY, 'on');
  show('Notifications are on', 'You are told when something new waits for you under Needs you, while this page is open in a tab.', 'harness-on');
}

function show(title: string, body: string, tag: string): void {
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      window.focus();
      location.hash = 'needs';
      notification.close();
    };
  } catch {
    // A browser that allows the permission and refuses the notification, as some do on a phone: the title still counts.
  }
}

/**
 * Tells the owner what arrives under Needs you while they look elsewhere: the page's
 * title counts the cards, in any case, and each card that comes is a notification of the
 * browser's, once the owner switched them on. Nothing is announced while the page is in
 * front, where the tab's badge shows it, nor what already waited when the page loaded.
 */
export function watchNeeds(): void {
  let told: Told | undefined;
  watch(() => harness.data, (data) => {
    if (!data) return;
    const needs: Need[] = listNeeds(data);
    document.title = `${needs.length > 0 ? `(${needs.length}) ` : ''}harness · ${data.design.project}`;
    const next = arrivals(needs, told, Date.now());
    told = next.told;
    if (!notifying.value || (document.visibilityState === 'visible' && document.hasFocus())) return;
    for (const need of next.fresh) show(`harness · ${data.design.project}: needs you`, needTitle(need), `harness-${need.key}`);
  }, { immediate: true });
}
