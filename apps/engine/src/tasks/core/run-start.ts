import type { TaskRunState, TaskRunTrigger } from "../types.ts";

export const TASK_RUN_SEED_SKILL = "working-on-a-task";

export interface TaskRunStartFacts {
  state: TaskRunState;
  conversation_id: string | null;
  playbook_revision: number | null;
  created_at: Date;
}

export type TaskRunStart = "ready" | "starting" | "stalled";

export function taskRunStart(facts: TaskRunStartFacts, stalled_before: Date): TaskRunStart {
  if (facts.state !== "running") return "ready";
  if (facts.conversation_id !== null && (facts.playbook_revision ?? 0) > 0) return "ready";
  return facts.created_at < stalled_before ? "stalled" : "starting";
}

export function taskRunSkillSlugs(task_skill_slugs: readonly string[]): string[] {
  return [...new Set([TASK_RUN_SEED_SKILL, ...task_skill_slugs])];
}

export interface LoadedSkill {
  slug: string;
  last_turn: number;
}

export function taskRunLoadedSkills(
  loaded: readonly LoadedSkill[],
  active: readonly string[],
): LoadedSkill[] | null {
  const known = new Set(loaded.map((entry) => entry.slug));
  const added = [...new Set(active)].filter((slug) => !known.has(slug));
  if (added.length === 0) return null;
  return [...loaded, ...added.map((slug) => ({ slug, last_turn: 0 }))];
}

export function taskRunStarterValid(trigger: TaskRunTrigger, by_person: boolean): boolean {
  return by_person === (trigger === "manual");
}
