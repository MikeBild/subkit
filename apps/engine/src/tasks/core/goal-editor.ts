export interface TaskGoalText {
  readonly goal: string;
  readonly done_when: string;
}

export interface TaskGoalWriter {
  readonly kind: string;
  readonly id: string;
  readonly auth_source?: { readonly kind: string } | undefined;
}

export function goalWriterId(writer: TaskGoalWriter | null): string | null {
  if (writer === null || writer.kind !== "user") return null;
  if (writer.auth_source?.kind === "task_run") return null;
  return writer.id;
}

export function nextGoalEditor(
  prior: TaskGoalText & { readonly goal_edited_by: string | null },
  next: TaskGoalText,
  writer: TaskGoalWriter | null,
): string | null {
  const unchanged = prior.goal === next.goal && prior.done_when === next.done_when;
  return unchanged ? prior.goal_edited_by : goalWriterId(writer);
}

export function ownerWroteGoal(owner_id: string, goal_edited_by: string | null): boolean {
  return goal_edited_by !== null && goal_edited_by === owner_id;
}
