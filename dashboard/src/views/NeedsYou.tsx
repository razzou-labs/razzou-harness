import { QAvatar, QBanner, QBtn, QCard, QCardSection, QInput } from 'quasar';
import { defineComponent, onMounted, ref, watch, type PropType, type VNodeChild } from 'vue';
import { getText, post, type DashboardState, type FeatureState } from '../api.ts';
import { clock } from '../format.ts';
import { list, listNeeds, waitText, type Need } from '../needs.ts';
import { Action, GithubLink, Loading, Markdown, Reply, text } from '../ui.tsx';
import type { Go } from '../App.tsx';

interface Card {
  key: string;
  title: string;
  body: () => VNodeChild;
}

const key = (f: FeatureState) => `${f.module}/${f.plan}/${f.feature}`;

/** Everything waiting for the owner as cards, in the order to handle them (`listNeeds`). */
export function collectNeeds(data: DashboardState, go: Go): Card[] {
  return listNeeds(data).map((need) => ({ key: need.key, ...card(need, go) }));
}

function card(need: Need, go: Go): Omit<Card, 'key'> {
  switch (need.kind) {
    case 'paused': {
      const paused = need.paused;
      return {
        title: 'The pipeline is paused',
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
        title: `[CHANGED_LOCKED_FILES] The Architect of ${module.module} asks to change locked files`,
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
        title: module.frozenCommit ? `[DESIGN_MODIFY] A change to the design of ${module.module} is ready for review` : `[DESIGN] The design of ${module.module} is ready for review`,
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
        title: `The Architect of ${module.module} proposes v${version}`,
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
        title: `The Manager asks the Architect of ${module.module}${escalation.feature ? ` about ${escalation.feature}` : ''}`,
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
        title: `The Manager of ${request.module} asks you`,
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
        title: `PR #${pr.number} of ${plan.module}/${plan.plan} waits for you`,
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
        title: `${plan.module}/${plan.plan} passed CI`,
        body: () => <p>Review and merge <GithubLink url={pr.url}>PR #{pr.number}</GithubLink> on GitHub, with a merge commit.</p>,
      };
    }
    case 'escalated': {
      const feature = need.feature;
      return { title: `${key(feature)} is escalated`, body: () => <Escalated feature={feature} /> };
    }
    case 'action': {
      const { action, status, holds, waits } = need;
      return {
        title: `${action.kind === 'gate' ? 'Gate' : 'Task'} ${need.module}/${action.id}: ${action.title}`,
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
    return () => {
      const needs = collectNeeds(props.data, props.go);
      if (needs.length === 0) return <p class="text-muted">Nothing needs you.</p>;
      // Numbered once there is an order to follow.
      const ordered = needs.length > 1;
      return (
        <div class="column q-gutter-md">
          {ordered && <div class="text-caption text-muted">In the order to handle them: what changes the design first; gates and tasks last, since marking one done starts new work.</div>}
          {needs.map((need, index) => (
            <QCard key={need.key} flat bordered class="need">
              <QCardSection>
                <div class="text-subtitle1 text-weight-medium q-mb-sm row items-center no-wrap">
                  {ordered && <div class="col-auto q-mr-sm"><QAvatar size="24px" fontSize="13px" color="primary" textColor="white">{index + 1}</QAvatar></div>}
                  <span class="col">{need.title}</span>
                </div>
                {need.body()}
              </QCardSection>
            </QCard>
          ))}
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
