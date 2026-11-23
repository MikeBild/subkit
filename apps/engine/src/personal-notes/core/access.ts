import type { ExecutionAuthSource, ResolvedPrincipal } from "../../auth/index.ts";

export interface NoteOwner {
  readonly user_id: string;
}

const OWNING_SOURCES: ReadonlySet<ExecutionAuthSource["kind"]> = new Set([
  "browser_session",
  "mcp_oauth",
  "task_run",
]);

export type NotePrincipal = Pick<ResolvedPrincipal, "kind" | "id" | "auth_source" | "via">;

export function noteOwner(principal: NotePrincipal | null | undefined): NoteOwner | null {
  if (principal?.kind !== "user") return null;
  if (principal.via === "token_exchange") return null;
  const source = principal.auth_source?.kind;
  if (!source || !OWNING_SOURCES.has(source)) return null;
  return { user_id: principal.id };
}

export function mayLearn(principal: NotePrincipal | null | undefined): boolean {
  if (!noteOwner(principal)) return false;
  return principal?.auth_source?.kind !== "task_run";
}
