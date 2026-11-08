import { run } from '../util.ts';

/** Where the harness builds its agents' image, whatever the version: `razzou-harness/agent:<version>`. */
const AGENT_REPOSITORY = 'razzou-harness/agent';
/** The label the agents' Dockerfile puts on the image: the Claude Code version inside. */
const AGENT_LABEL = 'dev.razzou-harness.claude-code';

/**
 * After the agents' image is built, removes the ones it replaces, about 2 GB each: the
 * other versions' tags, and the untagged images that building a tag again leaves.
 * Docker refuses to remove an image a container uses, so those are kept. A project
 * with an image of its own keeps every other one.
 */
export async function removeOldAgentImages(built: string, bin = 'docker'): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  if (!built.startsWith(`${AGENT_REPOSITORY}:`)) return { removed, kept };
  const listed = await run(bin, ['image', 'ls', '--filter', `label=${AGENT_LABEL}`, '--format', '{{.Repository}}:{{.Tag}}\t{{.ID}}']).catch(() => undefined);
  if (listed?.code !== 0) return { removed, kept };
  for (const [name, id] of listed.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'))) {
    const untagged = name === '<none>:<none>';
    if (!untagged && (!name?.startsWith(`${AGENT_REPOSITORY}:`) || name === built)) continue;
    const what = untagged ? `an untagged image (${id})` : name!;
    const result = await run(bin, ['image', 'rm', untagged ? id! : name!]).catch(() => undefined);
    (result?.code === 0 ? removed : kept).push(what);
  }
  return { removed, kept };
}

/** Docker's build cache, which every build on the machine shares: its size, and how much of it Docker can free. */
export async function buildCache(bin = 'docker'): Promise<{ size: string; reclaimable: string } | undefined> {
  const df = await run(bin, ['system', 'df', '--format', '{{json .}}']).catch(() => undefined);
  if (df?.code !== 0) return undefined;
  for (const line of df.stdout.split('\n').filter((l) => l.startsWith('{'))) {
    const row = JSON.parse(line) as { Type?: string; Size?: string; Reclaimable?: string };
    if (row.Type === 'Build Cache') return { size: row.Size ?? '?', reclaimable: (row.Reclaimable ?? '?').replace(/\s*\(.*\)$/, '') };
  }
  return undefined;
}
