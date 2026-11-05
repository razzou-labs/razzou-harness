import type { State } from '../state/state.ts';
import type { Config, Design, ModuleDesign } from './schemas.ts';

/**
 * The owner's time as a design constraint (proposal v3 §4.1). The owner sets the hours
 * the whole project may take of their time; the Architect estimates every owner action;
 * reading a proposal counts at the owner's rate; a reserve stays out of what designs may
 * plan. `submit_design` refuses a design that doesn't fit.
 */
export interface ModuleOwnerTime {
  module: string;
  /** The estimates of the module's owner actions, in minutes. */
  actionMinutes: number;
  /** Reading the accepted proposal, at the owner's rate, in minutes. */
  readingMinutes: number;
  /** The actions without an estimate: a design needs one on every action once hours are set. */
  missing: string[];
  /** The module's design is on main, submitted or frozen: its time is committed. */
  committed: boolean;
  /** The estimates of the actions marked done, and the accepted proposal once read. */
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

export const plannedMinutes = (time: ModuleOwnerTime): number => time.actionMinutes + time.readingMinutes;

/** The hours a number of lines takes the owner to read. */
export function readingMinutes(config: Settings, lines: number): number {
  return (lines / config.ownerTime.linesPerHour) * 60;
}

/**
 * One module's owner time. `proposalLines` is the length of its accepted proposal, 0
 * when there is none, as for a design written by hand.
 */
export function moduleOwnerTime(config: Settings, module: ModuleDesign, state: State, proposalLines: number): ModuleOwnerTime {
  const status = state.modules[module.id]?.status;
  const committed = status === undefined || status === 'in_review' || status === 'frozen';
  const reading = readingMinutes(config, proposalLines);
  let actionMinutes = 0;
  let usedMinutes = state.modules[module.id]?.accepted !== undefined ? reading : 0;
  const missing: string[] = [];
  for (const action of module.actions) {
    if (action.estimatedMinutes === undefined) {
      missing.push(action.id);
      continue;
    }
    actionMinutes += action.estimatedMinutes;
    if (state.actions[`${module.id}/${action.id}`]?.status === 'done') usedMinutes += action.estimatedMinutes;
  }
  return { module: module.id, actionMinutes, readingMinutes: reading, missing, committed, usedMinutes };
}

/** The whole project's owner time, or undefined while the owner hasn't set their hours. */
export function ownerTime(config: Settings, design: Design, state: State, proposalLines: (module: string, version: number) => number): OwnerTime | undefined {
  const hours = state.budgets.ownerHours;
  if (hours === undefined) return undefined;
  const modules = design.modules.map((module) => {
    const accepted = state.modules[module.id]?.accepted;
    return moduleOwnerTime(config, module, state, accepted === undefined ? 0 : proposalLines(module.id, accepted));
  });
  const reservePercent = config.ownerTime.reservePercent;
  return {
    hours,
    reservePercent,
    plannableHours: round(hours * (1 - reservePercent / 100)),
    committedHours: round(modules.filter((m) => m.committed).reduce((sum, m) => sum + plannedMinutes(m), 0) / 60),
    usedHours: round(modules.reduce((sum, m) => sum + m.usedMinutes, 0) / 60),
    modules,
  };
}

/** The hours a module may plan: what is plannable, minus what the other modules committed. */
export function availableHours(time: OwnerTime, module: string): number {
  const others = time.modules.filter((m) => m.committed && m.module !== module).reduce((sum, m) => sum + plannedMinutes(m), 0) / 60;
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
  const planned = round(plannedMinutes(candidate) / 60);
  if (planned > available) {
    problems.push(
      `the design takes ${planned} h of the owner's time (${round(candidate.actionMinutes / 60)} h of owner actions, ${round(candidate.readingMinutes / 60)} h to read the proposal), ` +
      `but ${available} h are available: ${time.hours} h for the project, minus the ${time.reservePercent}% reserve and what other modules committed. ` +
      'Cut or shorten the owner actions: decide what you can, and ask only for what only the owner can do.',
    );
  }
  return problems;
}

/** What `get_owner_time` tells the Architect. */
export function describeOwnerTime(time: OwnerTime | undefined, module: string, proposalLines: number, config: Settings): string {
  if (!time) return "The owner hasn't set a time budget: estimatedMinutes on owner actions is welcome, not required.";
  const mine = time.modules.find((m) => m.module === module);
  const others = round(time.committedHours - (mine?.committed ? plannedMinutes(mine) / 60 : 0));
  const reading = round(readingMinutes(config, proposalLines) / 60);
  return [
    `The owner set ${time.hours} h for the whole project. A ${time.reservePercent}% reserve (${round(time.hours - time.plannableHours)} h) stays out of designs, for escalations, questions and merges.`,
    `Other modules committed ${others} h. Available to ${module}: ${availableHours(time, module)} h.`,
    `Reading your accepted proposal takes ${reading} h (${proposalLines} lines at ${config.ownerTime.linesPerHour} an hour). The rest is for owner actions: give each an estimatedMinutes, and keep the sum within what is available, or submit_design refuses.`,
    `Used so far, project-wide: ${time.usedHours} h.`,
  ].join('\n');
}

const round = (hours: number): number => Math.round(hours * 100) / 100;
