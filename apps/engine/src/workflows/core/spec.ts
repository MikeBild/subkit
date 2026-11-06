import { workflowJsonDigest } from "../canonical-json.ts";
import { type WorkflowSpec, WorkflowSpecSchema } from "../draft-schemas.ts";

export interface SpecCarrier {
  spec: Record<string, unknown> | null;
}

export function carriedSpecColumns(base: SpecCarrier | null | undefined): SpecCarrier {
  return { spec: base?.spec ?? null };
}

export function readStoredSpec(value: unknown): WorkflowSpec | null {
  const parsed = WorkflowSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface SpecAuthority {
  kind: string;
  auth_source?: { kind: string } | null | undefined;
  credential_origin?: string | null | undefined;
}

export function speaksAsPerson(authority: SpecAuthority | null | undefined): boolean {
  return (
    authority?.kind === "user" &&
    (authority.auth_source?.kind === "browser_session" ||
      authority.credential_origin === "cli_oauth_session")
  );
}

export function personOriginRefused(
  requested: WorkflowSpec | undefined,
  base: unknown,
  authority: SpecAuthority | null | undefined,
): boolean {
  if (requested?.origin !== "person") return false;
  if (workflowSpecDigest(requested) === workflowSpecDigest(base)) return false;
  return !speaksAsPerson(authority);
}

export function workflowSpecDigest(spec: unknown): string {
  return workflowJsonDigest(spec ?? null);
}
