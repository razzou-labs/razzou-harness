import { matTerminal } from '@quasar/extras/material-icons';
import { QBtn, QCard, QCardSection, QExpansionItem, QItem, QItemLabel, QItemSection, QLinearProgress, QList } from 'quasar';
import { defineComponent, onUnmounted, ref, watch, type PropType } from 'vue';
import { post, type DashboardState, type Denial } from '../api.ts';
import { DenialTable } from '../components/Denials.tsx';
import { Terminal } from '../components/Terminal.tsx';
import { Transcript } from '../components/Transcript.tsx';
import { clock, duration } from '../format.ts';
import { Badge, Reply } from '../ui.tsx';
import type { Go } from '../App.tsx';

interface Card {
  id: string;
  role: 'Architect' | 'Manager' | 'Developer' | 'Reviewer';
  title: string;
  status: string;
  detail: string;
  /** Set while the sandbox is there: the owner can open a shell in it. */
  sandbox?: string;
  /** The deadline of a running attempt, against its start. */
  clock?: { start: number; deadline: number };
  /** What an attempt's sandbox policy refused, kept when its sandbox went. */
  refused?: Denial[];
}

const LIVE = ['starting', 'running', 'collecting', 'checking', 'reviewing'];

/** One card per agent, and the selected one's terminal, transcript or shell (§14.1, §14.3). */
export const Agents = defineComponent({
  props: {
    data: { type: Object as PropType<DashboardState>, required: true },
    go: { type: Function as PropType<Go>, required: true },
    selected: String,
  },
  setup(props) {
    const now = ref(Date.now());
    const timer = window.setInterval(() => (now.value = Date.now()), 1000);
    onUnmounted(() => window.clearInterval(timer));
    const shell = ref(false);
    watch(() => props.selected, () => (shell.value = false));
    return () => {
      const cards = agentCards(props.data);
      const current = cards.find((c) => c.id === props.selected) ?? cards[0];
      if (!current) return <p class="text-grey-7">No agent yet: start a module in the Project view.</p>;
      return (
        <div class="row q-col-gutter-md items-start">
          <div class="col-12 col-md-4 col-lg-3">
            <QList bordered separator class="rounded-borders agent-list">
              {cards.map((card) => (
                <QItem key={card.id} clickable active={card.id === current.id} activeClass="agent-active" onClick={() => props.go('agents', card.id)}>
                  <QItemSection>
                    <QItemLabel><b>{card.role}</b> · {card.title}</QItemLabel>
                    <QItemLabel caption class="row items-center q-gutter-xs">
                      <Badge status={card.status} /> <span>{card.detail}</span>
                    </QItemLabel>
                    {card.clock && <Deadline now={now.value} start={card.clock.start} deadline={card.clock.deadline} />}
                  </QItemSection>
                </QItem>
              ))}
            </QList>
          </div>
          <div class="col-12 col-md">
            <QCard flat bordered>
              <QCardSection>
                <div class="row items-center q-gutter-sm q-mb-sm">
                  <div class="text-h6">{current.role} · {current.title}</div>
                  <div class="col" />
                  {current.sandbox && props.data.terminals && (
                    <QBtn outline dense noCaps color="primary" padding="2px 10px" icon={shell.value ? undefined : matTerminal}
                      label={shell.value ? 'Back' : `Shell in ${current.sandbox}`} onClick={() => (shell.value = !shell.value)} />
                  )}
                  {current.sandbox && <QBtn flat dense noCaps color="primary" label="Its sandbox" onClick={() => props.go('sandboxes', current.sandbox)} />}
                </div>
                {shell.value && current.sandbox
                  ? <Terminal key={`shell:${current.sandbox}`} sandbox={current.sandbox} />
                  : <AgentView card={current} data={props.data} />}
              </QCardSection>
            </QCard>
          </div>
        </div>
      );
    };
  },
});

const AgentView = defineComponent({
  props: {
    card: { type: Object as PropType<Card>, required: true },
    data: { type: Object as PropType<DashboardState>, required: true },
  },
  setup(props) {
    return () => {
      const card = props.card;
      if (card.role === 'Architect') {
        const module = card.id.slice('architect:'.length);
        if (!props.data.terminals) return <p>The dashboard has no terminals here: node-pty didn't install. Use <code>harness attach {module}</code>.</p>;
        return (
          <>
            <Terminal key={`architect:${module}`} module={module} />
            <p class="text-caption text-grey-7 q-mt-xs">The Architect's own terminal, shared with <code>harness attach {module}</code>. It keeps running when you leave.</p>
          </>
        );
      }
      if (card.role === 'Manager') {
        // The message goes to this Manager: in Swarm each plan in flight has its own (v3 §6.4).
        const manager = card.id.slice('manager:'.length);
        return (
          <>
            <Transcript agent={card.id} />
            <div class="q-mt-sm">
              <Reply label="Send to the Manager" placeholder="A message for the Manager" send={(message) => post('/api/message', { text: message, manager })} />
            </div>
          </>
        );
      }
      return (
        <>
          {card.refused && card.refused.length > 0 && (
            <QExpansionItem dense denseToggle class="q-mb-sm" headerClass="text-warning" label={`Its sandbox's network policy refused ${refusedHosts(card.refused)}`}>
              <DenialTable denials={card.refused} />
            </QExpansionItem>
          )}
          <Transcript agent={card.id} />
        </>
      );
    };
  },
});

function agentCards({ state }: DashboardState): Card[] {
  const cards: Card[] = [];
  for (const module of Object.values(state.modules)) {
    cards.push({
      id: `architect:${module.module}`,
      role: 'Architect',
      title: module.module,
      status: module.architect.status,
      detail: `module ${module.status.replace(/_/g, ' ')}`,
      ...(module.architect.sandbox ? { sandbox: module.architect.sandbox } : {}),
    });
  }
  for (const manager of Object.values(state.managers)) {
    const key = manager.plan ? `${manager.module}/${manager.plan}` : manager.module;
    cards.push({
      id: `manager:${key}`,
      role: 'Manager',
      title: key,
      status: manager.status,
      detail: manager.launchedAt ? `launch ${manager.launch}, at ${clock(manager.launchedAt)}` : '',
      ...(manager.status !== 'stopped' && manager.sandbox ? { sandbox: manager.sandbox } : {}),
    });
  }
  // The reviewers' sessions on the plans' pull requests (v3 §5), newest first.
  const reviews = Object.values(state.plans)
    .flatMap((plan) => (plan.reviews ?? []).map((review) => ({ plan, review })))
    .sort((a, b) => Date.parse(b.review.startedAt) - Date.parse(a.review.startedAt))
    .slice(0, 6);
  for (const { plan, review } of reviews) {
    const live = review.status === 'starting' || review.status === 'running';
    const blocking = review.findings?.filter((f) => f.severity === 'blocking').length ?? 0;
    cards.push({
      id: `${review.role}:${review.head.slice(0, 8)}`,
      role: 'Reviewer',
      title: `${plan.module}/${plan.plan} · ${review.role} · ${review.head.slice(0, 8)}`,
      status: review.status === 'reported' ? review.verdict ?? 'reported' : review.status,
      detail: review.status === 'reported' ? `${blocking} blocking` : review.status === 'failed' ? review.reason ?? '' : '',
      ...(live ? { sandbox: review.sandbox, clock: { start: Date.parse(review.startedAt), deadline: Date.parse(review.deadline) } } : {}),
    });
  }
  // The running attempt first, then the last few that ended.
  const attempts = Object.values(state.features)
    .flatMap((feature) => feature.attempts.map((attempt) => ({ feature, attempt })))
    .sort((a, b) => Date.parse(b.attempt.startedAt) - Date.parse(a.attempt.startedAt))
    .slice(0, 8);
  for (const { feature, attempt } of attempts) {
    const live = LIVE.includes(attempt.status);
    const usage = attempt.usage ? ` · ${attempt.usage.outputTokens.toLocaleString()} tokens written` : '';
    const refused = attempt.refused?.length ? ` · refused ${refusedHosts(attempt.refused)}` : '';
    cards.push({
      id: `developer:${feature.module}/${feature.plan}/${feature.feature}/a${attempt.n}`,
      role: 'Developer',
      title: `${feature.module}/${feature.plan}/${feature.feature} #${attempt.n}`,
      status: attempt.status,
      detail: live ? refused.slice(3) : `${attempt.outcome ?? ''}${usage}${refused}`,
      ...(live ? { sandbox: attempt.sandbox, clock: { start: Date.parse(attempt.startedAt), deadline: Date.parse(attempt.deadline) } } : {}),
      ...(attempt.refused ? { refused: attempt.refused } : {}),
    });
  }
  return cards;
}

/** `pypi.org:443`, or `pypi.org:443 and 2 more`: the hosts refused, the latest first. */
function refusedHosts(denials: Denial[]): string {
  const targets = [...new Set(denials.map((d) => d.target))];
  return targets.length > 1 ? `${targets[0]} and ${targets.length - 1} more` : targets[0] ?? '';
}

const Deadline = defineComponent({
  props: { now: { type: Number, required: true }, start: { type: Number, required: true }, deadline: { type: Number, required: true } },
  setup(props) {
    return () => {
      const share = Math.min(1, (props.now - props.start) / Math.max(1, props.deadline - props.start));
      return (
        <div class="q-mt-xs" title={`deadline ${new Date(props.deadline).toLocaleTimeString()}`}>
          <QLinearProgress value={share} color={share > 0.8 ? 'warning' : 'primary'} trackColor="grey-4" rounded size="6px" />
          <div class="text-caption text-grey-7">{duration(props.now - props.start)} of {duration(props.deadline - props.start)}</div>
        </div>
      );
    };
  },
});
