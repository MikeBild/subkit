import type { ElicitationOpening, ElicitationRecord } from "../conversations/elicitations.ts";

export function opened<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error("the question was refused");
  return result as Extract<T, { ok: true }>;
}

export function openedElicitation(opening: ElicitationOpening): ElicitationRecord {
  return opened(opening).elicitation;
}
