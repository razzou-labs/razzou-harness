import { QBtn, QCard, QCardSection, QInput } from 'quasar';
import { defineComponent, onMounted, ref, watch, type PropType, type VNodeChild } from 'vue';
import { getText, post, type DashboardState, type FeatureState } from '../api.ts';
import { clock } from '../format.ts';
import { Action, GithubLink, Markdown, Reply, text } from '../ui.tsx';
import type { Go } from '../App.tsx';

interface Need {
  key: string;
  title: string;
  body: () => VNodeChild;
}

const key = (f: FeatureState) => `${f.module}/${f.plan}/${f.feature}`;

/** Everything waiting for the owner, most urgent first (§14.1). */
export function collectNeeds({ state, design }: DashboardState, go: Go): Need[] {
  const needs: Need[] = [];
  const paused = state.pipeline.paused;
  if (paused) {
    needs.push({
      key: 'paused',
      title: 'The pipeline is paused',
      body: () => (
        <>
          <p>{paused.reason}{paused.until ? ` (until ${clock(paused.until)})` : ''}</p>
          <Action label="Resume" run={() => post('/api/resume')} />
        </>
      ),
    });
  }
  for (const request of Object.values(state.ownerRequests).filter((r) => r.answer === undefined)) {
    needs.push({
      key: `request:${request.requestId}`,
      title: `The Manager of ${request.module} asks you`,
      body: () => (
        <>
          <Markdown text={request.question} />
          {request.blocking && <p class="text-caption text-grey-7">No new attempt starts until you answer.</p>}
          <Reply label="Answer" placeholder="Your answer" send={(answer) => post('/api/answer', { id: request.requestId, text: answer })} />
        </>
      ),
    });
  }
  for (const module of Object.values(state.modules)) {
    const latest = module.proposals.at(-1);
    if (module.status === 'proposed' && latest && !latest.acceptedAt) {
      needs.push({
        key: `proposal:${module.module}`,
        title: `The Architect of ${module.module} proposes v${latest.version}`,
        body: () => (
          <>
            <Proposal module={module.module} version={latest.version} />
            <div class="row items-center q-gutter-sm q-mt-sm">
              <Action label={`Accept v${latest.version}`} run={() => post('/api/accept', { module: module.module, version: latest.version })} />
              <QBtn flat dense noCaps color="primary" label="Ask for changes in its terminal" onClick={() => go('agents', `architect:${module.module}`)} />
            </div>
          </>
        ),
      });
    }
    if (module.status === 'in_review' && module.design?.pr) {
      const pr = module.design.pr;
      needs.push({
        key: `design:${module.module}`,
        title: module.frozenCommit ? `A change to the design of ${module.module} is ready for review` : `The design of ${module.module} is ready for review`,
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
      });
    }
    for (const escalation of module.escalations.filter((e) => e.decision === undefined)) {
      needs.push({
        key: `escalation:${escalation.id}`,
        title: `The Manager asks the Architect of ${module.module}${escalation.feature ? ` about ${escalation.feature}` : ''}`,
        body: () => (
          <>
            <Markdown text={escalation.question} />
            <p class="text-caption text-grey-7">The Architect decides. You can weigh in at its terminal.</p>
            <QBtn outline dense noCaps color="primary" padding="2px 10px" label="Open its terminal" onClick={() => go('agents', `architect:${module.module}`)} />
          </>
        ),
      });
    }
  }
  for (const plan of Object.values(state.plans).filter((p) => p.pr && (p.status === 'ready_to_merge' || p.status === 'pr_open'))) {
    const pr = plan.pr!;
    // In Swarm, the merge policy may leave a PR to the owner, with its reason (v3 §3.2).
    if (plan.leftToOwner) {
      const reason = plan.leftToOwner.reason;
      needs.push({
        key: `left:${plan.module}/${plan.plan}`,
        title: `PR #${pr.number} of ${plan.module}/${plan.plan} waits for you`,
        body: () => (
          <>
            <p>{reason}</p>
            <p>Review and merge <GithubLink url={pr.url}>PR #{pr.number}</GithubLink> on GitHub, with a merge commit.</p>
          </>
        ),
      });
    } else if (plan.status === 'ready_to_merge') {
      needs.push({
        key: `merge:${plan.module}/${plan.plan}`,
        title: `${plan.module}/${plan.plan} passed CI`,
        body: () => <p>Review and merge <GithubLink url={pr.url}>PR #{pr.number}</GithubLink> on GitHub, with a merge commit.</p>,
      });
    }
  }
  for (const feature of Object.values(state.features).filter((f) => f.status === 'escalated')) {
    needs.push({ key: `escalated:${key(feature)}`, title: `${key(feature)} is escalated`, body: () => <Escalated feature={feature} /> });
  }
  for (const module of design.modules) {
    for (const action of module.actions) {
      const status = state.actions[`${module.id}/${action.id}`];
      if (status?.status === 'done') continue;
      needs.push({
        key: `action:${module.id}/${action.id}`,
        title: `${action.kind === 'gate' ? 'Gate' : 'Task'} ${module.id}/${action.id}: ${action.title}`,
        body: () => (
          <>
            {action.blocks.length > 0 && <p class="text-caption text-grey-7">Holds back {action.blocks.join(', ')} until it's done.</p>}
            <Markdown text={action.instructions} />
            {status?.status === 'verifying' && <p class="text-caption text-primary">Its check is running.</p>}
            {status?.status === 'refused' && <p class="text-caption text-negative">Its check failed: {status.reason}</p>}
            <Reply
              label={action.verify ? 'Done: run its check' : 'Mark done'}
              placeholder="A note (optional)"
              optional
              send={(note) => post('/api/actions/done', { module: module.id, action: action.id, ...(note ? { note } : {}) })}
            />
          </>
        ),
      });
    }
  }
  return needs;
}

export const NeedsYou = defineComponent({
  props: {
    data: { type: Object as PropType<DashboardState>, required: true },
    go: { type: Function as PropType<Go>, required: true },
  },
  setup(props) {
    return () => {
      const needs = collectNeeds(props.data, props.go);
      if (needs.length === 0) return <p class="text-grey-7">Nothing needs you.</p>;
      return (
        <div class="column q-gutter-md">
          {needs.map((need) => (
            <QCard key={need.key} flat bordered class="need">
              <QCardSection>
                <div class="text-subtitle1 text-weight-medium q-mb-sm">{need.title}</div>
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
    return () => <div class="document">{content.value === undefined ? <p class="text-grey-7">Loading…</p> : <Markdown text={content.value} />}</div>;
  },
});
