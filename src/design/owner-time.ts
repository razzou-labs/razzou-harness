import type { State } from '../state/state.ts';
import type { Config, ModuleDesign } from './schemas.ts';

/**
 * The owner's time as a design constraint. The owner sets, for a module, the hours it
 * may take of their time; its Architect estimates every owner action of its design, the
 * gates and tasks; a reserve stays out of what the design may plan; and `submit_design`
 * refuses a design that doesn't fit. The hours are a module's own: what another module
 * plans takes nothing from them, and a module without hours is designed without a limit.
 * Only owner actions count: what the owner reads, proposals and pull requests, is their
 * own and isn't measured.
 */
export interface ModuleOwnerTime {
  module: string;
  /** The hours the owner set for this module; undefined while they set none. */
  hours?: number;
  reservePercent: number;
  /** What its design may plan: the hours minus the reserve. */
  plannableHours?: number;
  /** The estimates of the module's owner actions, in minutes: what its design plans of the owner's time. */
  plannedMinutes: number;
  /** The actions without an estimate: a design needs one on every action once hours are set. */
  missing: string[];
  /** The estimates of the actions marked done, with those a redesign dropped since. */
  usedMinutes: number;
  /** Of `usedMinutes`, the actions done and then dropped by a redesign: time spent, which counts against what may still be planned. */
  droppedMinutes: number;
}

type Settings = Pick<Config, 'ownerTime'>;

/** One module's owner time: its hours, and the estimates of the owner actions of `module`, its design on main or one being submitted. */
export function moduleOwnerTime(config: Settings, module: ModuleDesign, state: State): ModuleOwnerTime {
  let plannedMinutes = 0;
  let usedMinutes = 0;
  const missing: string[] = [];
  for (const action of module.actions) {
    if (action.estimatedMinutes === undefined) {
      missing.push(action.id);
      continue;
    }
    plannedMinutes += action.estimatedMinutes;
    if (state.actions[`${module.id}/${action.id}`]?.status === 'done') usedMinutes += action.estimatedMinutes;
  }
  // An action done, then dropped by a redesign, still took the owner's time: its estimate when it was done.
  const designed = new Set(module.actions.map((a) => `${module.id}/${a.id}`));
  let droppedMinutes = 0;
  for (const [key, action] of Object.entries(state.actions)) {
    if (key.startsWith(`${module.id}/`) && !designed.has(key) && action.status === 'done') droppedMinutes += action.minutes ?? 0;
  }
  const hours = state.ownerHours[module.id]?.hours;
  const reservePercent = config.ownerTime.reservePercent;
  return {
    module: module.id,
    ...(hours === undefined ? {} : { hours, plannableHours: round(hours * (1 - reservePercent / 100)) }),
    reservePercent,
    plannedMinutes,
    missing,
    usedMinutes: usedMinutes + droppedMinutes,
    droppedMinutes,
  };
}

/**
 * Why a module's design doesn't fit the hours the owner set for it, as `submit_design`
 * reports it, or nothing: nothing is asked of a module without hours.
 */
export function ownerTimeProblems(time: ModuleOwnerTime): string[] {
  if (time.hours === undefined || time.plannableHours === undefined) return [];
  const problems = time.missing.map((id) => `owner-actions.json: ${id} needs estimatedMinutes, how long it takes the owner: their time for this module is set (get_owner_time)`);
  if (problems.length > 0) return problems;
  const planned = round(time.plannedMinutes / 60);
  const dropped = round(time.droppedMinutes / 60);
  // A design that asks nothing more of the owner always fits.
  if (planned > 0 && round(planned + dropped) > time.plannableHours) {
    problems.push(
      `the design takes ${planned} h of the owner's time in owner actions${dropped > 0 ? `, after ${dropped} h of actions already done that it drops` : ''}, but this module may plan ${time.plannableHours} h: ` +
      `${time.hours} h set by the owner, minus the ${time.reservePercent}% reserve. ` +
      'Cut or shorten the owner actions: decide what you can, and ask only for what only the owner can do.',
    );
  }
  return problems;
}

/** What `get_owner_time` tells the Architect. */
export function describeOwnerTime(time: ModuleOwnerTime): string {
  if (time.hours === undefined || time.plannableHours === undefined) {
    return `The owner set no hours for ${time.module}: estimatedMinutes on owner actions is welcome, not required.`;
  }
  const dropped = round(time.droppedMinutes / 60);
  return [
    `The owner set ${time.hours} h of their time for ${time.module}, this module alone: what other modules plan takes nothing from it. A ${time.reservePercent}% reserve (${round(time.hours - time.plannableHours)} h) stays out of the design, for escalations, questions and merges.`,
    `Your design may plan ${round(time.plannableHours - dropped)} h in owner actions${dropped > 0 ? ` (${dropped} h went to actions done and since dropped)` : ''}; it plans ${round(time.plannedMinutes / 60)} h on main now.`,
    'Only owner actions count: give every gate and task an estimatedMinutes, how long it takes the owner, and keep their sum within that, or submit_design refuses. What the owner reads, proposals and pull requests, doesn\'t count.',
    `Used so far in this module: ${round(time.usedMinutes / 60)} h, the actions marked done.`,
  ].join('\n');
}

const round = (hours: number): number => Math.round(hours * 100) / 100;
