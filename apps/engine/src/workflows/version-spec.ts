import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowVersions } from "../db/schema/index.ts";
import { workflowJsonDigest } from "./canonical-json.ts";
import { type WorkflowSpec, WorkflowSpecSchema } from "./draft-schemas.ts";

export interface SpecCarrier {
  spec: Record<string, unknown> | null;
}

export function carriedSpecColumns(base: SpecCarrier | null | undefined): SpecCarrier {
  return { spec: base?.spec ?? null };
}

export async function loadVersionSpec(
  exec: Executor,
  scope: { tenant_id: string; workflow_id: string; version_id: string | null },
): Promise<SpecCarrier | null> {
  if (!scope.version_id) return null;
  const [row] = await exec
    .select({ spec: workflowVersions.spec })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, scope.tenant_id),
        eq(workflowVersions.workflow_id, scope.workflow_id),
        eq(workflowVersions.id, scope.version_id),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function readStoredSpec(value: unknown): WorkflowSpec | null {
  if (value === null || value === undefined) return null;
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
