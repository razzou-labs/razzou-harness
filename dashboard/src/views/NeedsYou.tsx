import { QAvatar, QBanner, QBtn, QCard, QCardSection, QInput } from 'quasar';
import { defineComponent, onMounted, ref, watch, type PropType, type VNodeChild } from 'vue';
import { getText, post, type DashboardState, type FeatureState } from '../api.ts';
import { clock } from '../format.ts';
import { list, listNeeds, needTitle, orderNeeds, waitText, type Need, type Ordered } from '../../../src/dashboard/needs.ts';
import { Action, Command, Fold, GithubLink, Loading, Markdown, Reply, text } from '../ui.tsx';
import type { Go } from '../App.tsx';

const key = (f: FeatureState) => `${f.module}/${f.plan}/${f.feature}`;

/** What a card holds under its title: its text, and its buttons or form. */
function content(need: Need, go: Go): { body: () => VNodeChild } {
  switch (need.kind) {
    case 'paused': {
      const paused = need.paused;
      return {
        body: () => (
          <>
            <p>{paused.reason}{paused.until ? ` (until ${clock(paused.until)})` : ''}</p>
            <Action label="Resume" run={() => post('/api/resume')} />
          </>
        ),
      };
    }
    // A change to built features' definitions: a card of its own, with what it puts at risk (v5).
    case 'locked': {
      const module = need.module;
      const locked = module.locked!;
      const pr = locked.pr!;
      return {
        body: () => (
          <>
            <QBanner class="bg-negative text-white q-mb-md" rounded>
              <b>Changing locked files can make a broken feature look like it works:</b> a check that proves less turns red into green without fixing anything.
              Merge only if each changed check still proves its feature's expected result.
              <div class="q-mt-xs">A locked change rebuilds nothing: if a feature must work differently, ask the Architect for a new plan.</div>
            </QBanner>
            <Markdown text={locked.summary} />
            {locked.changes.map((c) => (
              <div key={`${c.plan}/${c.feature}`} class="locked-change q-mb-sm">
                <div><b>{c.plan}/{c.feature}</b> {c.title}</div>
                <div class="text-caption"><span class="text-muted">Expected:</span> {c.expected}</div>
                {c.fields.length > 0 && <div class="text-caption"><span class="text-muted">Spec fields:</span> {c.fields.join(', ')}</div>}
                {c.checks.length > 0 && <div class="text-caption"><span class="text-muted">Checks:</span> {c.checks.join(', ')}</div>}
                {c.scripts.length > 0 && <div class="text-caption"><span class="text-muted">Scripts:</span> {c.scripts.map((s) => <code key={s} class="q-mr-xs">{s}</code>)}</div>}
              </div>
            ))}
            <p>
              Review the diff of <GithubLink url={pr.url}>PR #{pr.number}</GithubLink> on GitHub, then merge it with a merge commit, or close it.
              Comments go to the Architect, in its terminal.
              {need.rechecks.length > 0 && ` The post-deploy checks of ${list(need.rechecks)} failed: they run again once this is merged.`}
            </p>
          </>
        ),
      };
    }
    case 'design': {
      const module = need.module;
      const pr = module.design!.pr!;
      return {
        body: () => (
          <>
            {module.frozenCommit && <p>{module.design?.summary}</p>}
            <p>
              Review and merge <GithubLink url={pr.url}>Arch PR #{pr.number}</GithubLink> on GitHub, with a merge commit.
              Comments go to the Architect, in its terminal.
              {module.frozenCommit && ' No new attempt starts in this module until you merge or close it.'}
            </p>
            {(module.design?.suspect.length ?? 0) > 0 && (
              <p class="text-caption text-warning">These checks already pass before anything is built, so they may test nothing: {module.design?.suspect.join(', ')}</p>
            )}
          </>
        ),
      };
    }
    case 'proposal': {
      const { module, version } = need;
      return {
        body: () => (
          <>
            <Proposal module={module.module} version={version} />
            <div class="row items-center q-gutter-sm q-mt-sm">
              <Action label={`Accept v${version}`} run={() => post('/api/accept', { module: module.module, version })} />
              <QBtn flat dense noCaps color="primary" label="Ask for changes in its terminal" onClick={() => go('agents', `architect:${module.module}`)} />
            </div>
          </>
        ),
      };
    }
    case 'escalation': {
      const { module, escalation } = need;
      return {
        body: () => (
          <>
            <Markdown text={escalation.question} />
            <p class="text-caption text-muted">The Architect decides. You can weigh in at its terminal.</p>
            <QBtn outline dense noCaps color="primary" padding="2px 10px" label="Open its terminal" onClick={() => go('agents', `architect:${module.module}`)} />
          </>
        ),
      };
    }
    case 'request': {
      const request = need.request;
      return {
        body: () => (
          <>
            <Markdown text={request.question} />
            {request.blocking && <p class="text-caption text-muted">No new attempt starts until you answer.</p>}
            <Reply label="Answer" placeholder="Your answer" send={(answer) => post('/api/answer', { id: request.requestId, text: answer })} />
          </>
        ),
      };
    }
    case 'left': {
      const plan = need.plan;
      const pr = plan.pr!;
      const reason = plan.leftToOwner!.reason;
      return {
        body: () => (
          <>
            <p>{reason}</p>
            <p>Review and merge <GithubLink url={pr.url}>PR #{pr.number}</GithubLink> on GitHub, with a merge commit.</p>
          </>
        ),
      };
    }
    case 'merge': {
      const plan = need.plan;
      const pr = plan.pr!;
      return {
        body: () => <p>Review and merge <GithubLink url={pr.url}>PR #{pr.number}</GithubLink> on GitHub, with a merge commit.</p>,
      };
    }
    case 'escalated': {
      const feature = need.feature;
      return { body: () => <Escalated feature={feature} /> };
    }
    case 'action': {
      const { action, status, holds, waits } = need;
      return {
        body: () => (
          <>
            {/* The Architect's sentence for the owner: the daemon can't check it, so it is the first thing said. */}
            <p class="q-mb-xs"><span class="text-muted">When:</span> {action.when}</p>
            {holds.length > 0 && <p class="text-caption text-muted q-mb-xs">Holds back {list(holds)} until it's done.</p>}
            {waits.map((wait) => (wait.failed
              ? <QBanner key={wait.plan} dense rounded class="note note-warn q-my-sm">{waitText(wait)}</QBanner>
              : <p key={wait.plan} class="text-caption text-muted q-mb-xs">{waitText(wait)}</p>
            ))}
            <Markdown text={action.instructions} />
            {status?.status === 'verifying' && <p class="text-caption text-primary">Its check is running.</p>}
            {status?.status === 'refused' && <p class="text-caption text-negative">Its check failed: {status.reason}</p>}
            <Reply
              label={action.verify ? 'Done: run its check' : 'Mark done'}
              placeholder="A note (optional)"
              optional
              send={(note) => post('/api/actions/done', { module: need.module, action: action.id, ...(note ? { note } : {}) })}
            />
          </>
        ),
      };
    }
  }
}

export const NeedsYou = defineComponent({
  props: {
    data: { type: Object as PropType<DashboardState>, required: true },
    go: { type: Function as PropType<Go>, required: true },
  },
  setup(props) {
    // The owner's switch back to the standard order while the Manager's holds; a new answer shows first.
    const standard = ref(false);
    watch(() => props.data.state.order?.requestId, () => (standard.value = false));
    return () => {
      const needs = listNeeds(props.data);
      if (needs.length === 0) return <p class="text-muted">Nothing needs you.</p>;
      const view = orderNeeds(needs, props.data.state.order);
      const managers = view.by === 'manager' && !standard.value;
      const shown = managers ? view.needs : needs;
      // Numbered once there is an order to follow.
      const ordered = shown.length > 1;
      return (
        <div class="column q-gutter-md">
          {ordered && <Order data={props.data} view={view} standard={standard.value} onToggle={() => (standard.value = !standard.value)} />}
          {shown.map((need, index) => {
            const why = managers ? view.why[need.key] : undefined;
            return (
              <QCard key={need.key} flat bordered class="need">
                <QCardSection>
                  <div class="text-subtitle1 text-weight-medium q-mb-sm row items-center no-wrap">
                    {ordered && <div class="col-auto q-mr-sm"><QAvatar size="24px" fontSize="13px" color="primary" textColor="white">{index + 1}</QAvatar></div>}
                    <span class="col">{needTitle(need)}</span>
                  </div>
                  {/* The Manager's own words, as text: why the card is where it put it. */}
                  {why !== undefined && (
                    <p class="q-mb-sm"><span class="text-muted">The Manager:</span> {why === '' ? 'left this card out of its order: it is last.' : why}</p>
                  )}
                  {content(need, props.go).body()}
                </QCardSection>
              </QCard>
            );
          })}
        </div>
      );
    };
  },
});

/** How long an order request waits before the owner can ask the same again, as the daemon counts it. */
const ORDER_WAIT_MS = 5 * 60_000;

/**
 * Above the cards: which order they are in, and the Manager's, which the owner asks for
 * when the cards' text says more than the standard order knows. Its order is advice about
 * the cards as they were when asked: it shows while they are the same, and gives way to
 * the standard order once one came or changed.
 */
const Order = defineComponent({
  props: {
    data: { type: Object as PropType<DashboardState>, required: true },
    view: { type: Object as PropType<Ordered>, required: true },
    standard: { type: Boolean, required: true },
    onToggle: { type: Function as PropType<() => void>, required: true },
  },
  setup(props) {
    /** The button that asks, or why nobody can be asked: a line of its own, under what it stands beside. */
    const ask = (label: string): { button?: VNodeChild; why?: VNodeChild } => {
      // A Manager made before it had the tool can't answer: the daemon starts a new one once its sandbox is gone.
      const running = Object.values(props.data.state.managers).filter((m) => m.status !== 'stopped');
      if (running.some((m) => m.tools?.includes('suggest_order'))) return { button: <Action flat label={label} run={() => post('/api/order')} /> };
      if (running.length === 0) return { why: <div class="text-caption text-muted q-mt-xs">No Manager is running to ask for an order: one starts with the build of a module.</div> };
      // Its tools are known once its sandbox is made.
      if (running.some((m) => m.status === 'starting')) return { why: <div class="text-caption text-muted q-mt-xs">A Manager is starting: it can be asked for an order in a moment.</div> };
      return {
        why: (
          <div class="text-caption text-muted q-mt-xs">
            To ask the Manager for an order, it needs a new sandbox, with the tool to answer: <Command text={`openshell sandbox delete ${running[0]!.sandbox}`} /> The daemon then starts a new one, without the old one's conversation.
          </div>
        ),
      };
    };
    return () => {
      const { view } = props;
      const order = props.data.state.order;
      const given = order?.suggestion;
      if (view.waiting && order) {
        const again = Date.now() - Date.parse(order.askedAt) > ORDER_WAIT_MS ? ask('Ask again') : {};
        return (
          <QBanner class="note note-info" rounded dense>
            <div class="row items-center q-gutter-sm">
              <Loading class="col" text={`The Manager was asked at ${clock(order.askedAt)} for an order of these cards. Until it answers, they are in the standard order.`} />
              {again.button}
            </div>
            {again.why}
          </QBanner>
        );
      }
      if (view.outdated && order && given) {
        const titles = new Map(order.cards.map((card) => [card.key, card.title]));
        const since = [
          ...(view.outdated.added.length > 0 ? [`${list(view.outdated.added.map((t) => `"${t}"`))} came`] : []),
          ...(view.outdated.changed.length > 0 ? [`${list(view.outdated.changed.map((t) => `"${t}"`))} changed`] : []),
        ].join(', and ');
        const again = ask('Ask again');
        return (
          <QBanner class="note note-warn" rounded dense>
            <div class="row items-center q-gutter-sm">
              <span class="col">The Manager's order of {clock(given.at)} no longer applies: since then, {since}. The cards are in the standard order.</span>
              {again.button}
            </div>
            {again.why}
            <Fold label={() => "The Manager's order then"}>
              <ol class="q-my-xs">
                {given.order.map(({ key, why }) => <li key={key}>{titles.get(key) ?? key}{why && <span class="text-muted">: {why}</span>}</li>)}
              </ol>
            </Fold>
          </QBanner>
        );
      }
      if (view.by === 'manager' && given) {
        return (
          <QBanner class="note note-info" rounded dense>
            <div class="row items-center q-gutter-sm">
              <span class="col">
                {props.standard
                  ? <>In the standard order. The Manager gave another at {clock(given.at)}.</>
                  : <>In <b>the Manager's order</b>, given at {clock(given.at)} for these cards. It is advice: what each card says still applies.</>}
              </span>
              <QBtn flat dense noCaps color="primary" padding="2px 10px" label={props.standard ? "Show the Manager's order" : 'Show the standard order'} onClick={props.onToggle} />
            </div>
            {!props.standard && given.summary && <Markdown text={given.summary} />}
          </QBanner>
        );
      }
      const first = ask('Ask the Manager for an order');
      return (
        <div>
          <div class="row items-center q-gutter-sm">
            <span class="col text-caption text-muted">In the order to handle them: what changes the design first; gates and tasks last, since marking one done starts new work.</span>
            {first.button}
          </div>
          {first.why}
        </div>
      );
    };
  },
});

/** One more attempt with guidance, the question to the Architect, or a pause (§14.2). */
const Escalated = defineComponent({
  props: { feature: { type: Object as PropType<FeatureState>, required: true } },
  setup(props) {
    const note = ref('');
    return () => {
      const feature = props.feature;
      return (
        <>
          <p>{feature.escalation}</p>
          <QInput {...text(note)} type="textarea" autogrow outlined dense label="Guidance for one more attempt, or a note for the Architect" />
          <div class="row items-center q-gutter-sm q-mt-sm">
            <Action label="One more attempt" run={() => post('/api/retry', { feature: key(feature), ...(note.value.trim() ? { note: note.value } : {}) })} />
            <Action
              label="Send it to the Architect"
              run={() =>
                post('/api/architect', {
                  module: feature.module,
                  text: `[owner] ${key(feature)} is escalated: ${feature.escalation ?? ''} ${note.value.trim() ? `My note: ${note.value.trim()}` : ''} Should the design change?`,
                })
              }
            />
            <Action label="Pause the pipeline" run={() => post('/api/pause')} />
          </div>
        </>
      );
    };
  },
});

/** A proposal's text, as the Architect submitted it. */
export const Proposal = defineComponent({
  props: { module: { type: String, required: true }, version: { type: Number, required: true } },
  setup(props) {
    const content = ref<string>();
    const load = () => {
      content.value = undefined;
      void getText(`/api/proposal?module=${encodeURIComponent(props.module)}&version=${props.version}`).then((t) => (content.value = t));
    };
    onMounted(load);
    watch(() => [props.module, props.version], load);
    return () => <div class="document">{content.value === undefined ? <Loading class="q-py-sm" text="Reading the proposal…" /> : <Markdown text={content.value} />}</div>;
  },
});
