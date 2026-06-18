// Shared slug-conflict mapping for workflow create + metadata update.
//
// A duplicate active slug raises Postgres `23505` on the partial unique index
// `workflows_tenant_slug_active_key` (tenant_id, slug WHERE deleted_at IS
// NULL). Both write paths map it to a clean structured conflict the HTTP route
// turns into a 4xx — instead of the unhandled 500 a duplicate-slug
// `POST /v1/workflows` was producing (raw insert error in the runtime logs).

import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";

/** Conflict shape returned alongside a slug-conflict error. */
export interface SlugConflict {
  workflow_id: string;
  slug: string;
  name: string;
}

/**
 * Map a unique-violation error to a structured slug-conflict result, or
 * `null` when the error is NOT a slug conflict — the caller must rethrow so
 * unrelated failures still surface.
 */
export async function slugConflictResult(
  err: unknown,
  db: Executor,
  tenant_id: string,
  desiredSlug: string,
): Promise<{ errors: string[]; conflict?: SlugConflict } | null> {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = (err as { code?: string }).code ?? cause?.code;
  const looksLikeSlugConflict =
    code === "23505" ||
    msg.includes("23505") ||
    msg.toLowerCase().includes("duplicate key") ||
    msg.includes("workflows_tenant_slug");
  if (!looksLikeSlugConflict) return null;
  const conflictRows = await db
    .select({ id: workflows.id, slug: workflows.slug, name: workflows.name })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.slug, desiredSlug),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const existing = conflictRows[0];
  return {
    errors: [
      existing
        ? `slug "${desiredSlug}" already belongs to workflow "${existing.name}" (id=${existing.id})`
        : `slug "${desiredSlug}" already exists for this tenant`,
    ],
    ...(existing
      ? { conflict: { workflow_id: existing.id, slug: existing.slug, name: existing.name } }
      : {}),
  };
}
