import type { ResolvedPrincipal } from "../../auth/types.ts";

export type SessionRefusal =
  | "no_person"
  | "no_browser_session"
  | "not_interactive_surface"
  | "task_run";

const INTERACTIVE_SURFACES = new Set(["web", "chat"]);

export interface SessionInput {
  readonly principal: Pick<
    ResolvedPrincipal,
    "kind" | "auth_source" | "credential_origin" | "api_key_id" | "via"
  > | null;
  readonly surface: string | null | undefined;
  readonly task_run: boolean;
}

export function interactivePersonRefusal(input: SessionInput): SessionRefusal | null {
  const { principal } = input;
  if (input.task_run || principal?.auth_source?.kind === "task_run") return "task_run";
  if (!principal || principal.kind !== "user") return "no_person";
  if (
    principal.auth_source?.kind !== "browser_session" ||
    principal.api_key_id !== undefined ||
    principal.via !== undefined ||
    (principal.credential_origin !== undefined && principal.credential_origin !== null)
  ) {
    return "no_browser_session";
  }
  if (!INTERACTIVE_SURFACES.has(input.surface ?? "")) return "not_interactive_surface";
  return null;
}
