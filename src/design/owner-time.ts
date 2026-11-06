import type { State } from '../state/state.ts';
import type { Config, Design, ModuleDesign } from './schemas.ts';

/**
 * The owner's time as a design constraint (proposal v3 §4.1). The owner sets the hours
 * the whole project may take of their time; the Architect estimates every owner action,
 * the gates and tasks of its design; a reserve stays out of what designs may plan; and
 * `submit_design` refuses a design that doesn't fit. Only owner actions count: what the
 * owner reads, proposals and pull requests, is their own and isn't measured.
 */
export interface ModuleOwnerTime {
  module: string;
  /** The estimates of the module's owner actions, in minutes: what its design plans of the owner's time. */
  plannedMinutes: number;
  /** The actions without an estimate: a design needs one on every action once hours are set. */
  missing: string[];
  /** The module's design is on main, submitted or frozen: its time is committed. */
  committed: boolean;
  /** The estimates of the actions marked done. */
  usedMinutes: number;
}

export interface OwnerTime {
  hours: number;
  reservePercent: number;
  /** What designs may plan in all: the hours minus the reserve. */
  plannableHours: number;
  /** The planned time of every committed module. */
  committedHours: number;
  usedHours: number;
  modules: ModuleOwnerTime[];
}

type Settings = Pick<Config, 'ownerTime'>;

/** One module's owner time: the estimates of its owner actions. */
export function moduleOwnerTime(module: ModuleDesign, state: State): ModuleOwnerTime {
  const status = state.modules[module.id]?.status;
  const committed = status === undefined || status === 'in_review' || status === 'frozen';
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
  return { module: module.id, plannedMinutes, missing, committed, usedMinutes };
}

/** The whole project's owner time, or undefined while the owner hasn't set their hours. */
export function ownerTime(config: Settings, design: Design, state: State): OwnerTime | undefined {
  const hours = state.budgets.ownerHours;
  if (hours === undefined) return undefined;
  const modules = design.modules.map((module) => moduleOwnerTime(module, state));
  const reservePercent = config.ownerTime.reservePercent;
  return {
    hours,
    reservePercent,
    plannableHours: round(hours * (1 - reservePercent / 100)),
    committedHours: round(modules.filter((m) => m.committed).reduce((sum, m) => sum + m.plannedMinutes, 0) / 60),
    usedHours: round(modules.reduce((sum, m) => sum + m.usedMinutes, 0) / 60),
    modules,
  };
}

/** The hours a module may plan: what is plannable, minus what the other modules committed. */
export function availableHours(time: OwnerTime, module: string): number {
  const others = time.modules.filter((m) => m.committed && m.module !== module).reduce((sum, m) => sum + m.plannedMinutes, 0) / 60;
  return round(time.plannableHours - others);
}

/**
 * Why a module's design doesn't fit the owner's time, as `submit_design` reports it, or
 * nothing. `candidate` is the design being submitted, in place of the module's current one.
 */
export function ownerTimeProblems(time: OwnerTime | undefined, candidate: ModuleOwnerTime): string[] {
  if (!time) return [];
  const problems = candidate.missing.map((id) => `owner-actions.json: ${id} needs estimatedMinutes, how long it takes the owner: their time is budgeted (get_owner_time)`);
  if (problems.length > 0) return problems;
  const available = availableHours(time, candidate.module);
  const planned = round(candidate.plannedMinutes / 60);
  if (planned > available) {
    problems.push(
      `the design takes ${planned} h of the owner's time in owner actions, but ${available} h are available: ` +
      `${time.hours} h for the project, minus the ${time.reservePercent}% reserve and what other modules committed. ` +
      'Cut or shorten the owner actions: decide what you can, and ask only for what only the owner can do.',
    );
  }
  return problems;
}

/** What `get_owner_time` tells the Architect. */
export function describeOwnerTime(time: OwnerTime | undefined, module: string): string {
  if (!time) return "The owner hasn't set a time budget: estimatedMinutes on owner actions is welcome, not required.";
  const mine = time.modules.find((m) => m.module === module);
  const others = round(time.committedHours - (mine?.committed ? mine.plannedMinutes / 60 : 0));
  return [
    `The owner set ${time.hours} h for the whole project. A ${time.reservePercent}% reserve (${round(time.hours - time.plannableHours)} h) stays out of designs, for escalations, questions and merges.`,
    `Other modules committed ${others} h. Available to ${module}: ${availableHours(time, module)} h.`,
    'Only owner actions count: give every gate and task an estimatedMinutes, how long it takes the owner, and keep their sum within what is available, or submit_design refuses. What the owner reads, proposals and pull requests, doesn\'t count.',
    `Used so far, project-wide: ${time.usedHours} h, the actions marked done.`,
  ].join('\n');
}

const round = (hours: number): number => Math.round(hours * 100) / 100;
