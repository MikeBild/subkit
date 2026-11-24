import { and, eq, sql } from "drizzle-orm";
import { CategorySchema } from "../api/catalog-metadata.ts";
import { toFileId } from "../api/files-schemas.ts";
import { type Actor, type AuditAction, auditActor, auditAwait } from "../audit/index.ts";
import type { Executor } from "../db/client.ts";
import {
  type IntakeAttachmentFacts,
  intakeCategoryDefaults,
  type intakeItems,
} from "../db/schema/intake.ts";
import {
  ANONYMOUS_COLLECTOR,
  type IntakeCollector,
  type IntakeItemOriginFilter,
  type IntakeItemView,
} from "./intake-types.ts";

export const DEFAULT_INTAKE_CATEGORY = "inbox";

export const INTAKE_ITEM_ORIGIN_FILTERS = ["capture", "note", "session"] as const;

export const INTAKE_ORIGIN_FILTER_VALUES: Record<
  IntakeItemOriginFilter,
  readonly IntakeItemView["original_snapshot"]["origin"][]
> = {
  capture: ["capture", "restored_draft"],
  note: ["note"],
  session: ["session"],
};

export function parseIntakeCategory(value: string): string {
  return CategorySchema.parse(value);
}

export function intakeActor(kind: string, id: string): Actor {
  return { kind: kind === "user" ? "user" : "system_account", id };
}

export function intakeCollector(kind: string, id: string | null): IntakeCollector {
  return kind === "anonymous" || id === null ? ANONYMOUS_COLLECTOR : intakeActor(kind, id);
}

export function collectorAuditActor(actor: IntakeCollector) {
  return actor.kind === "anonymous"
    ? { actor_type: "unknown" as const, actor_id: null }
    : auditActor(actor);
}

function wireAttachment(attachment: IntakeAttachmentFacts): IntakeAttachmentFacts {
  return attachment.file_id.startsWith("fid_")
    ? attachment
    : { ...attachment, file_id: toFileId(attachment.file_id) };
}

function wireSnapshot(snapshot: IntakeItemView["original_snapshot"]) {
  return snapshot.origin === "note" && snapshot.attachment
    ? { ...snapshot, attachment: wireAttachment(snapshot.attachment) }
    : snapshot;
}

export function intakeItemView(row: typeof intakeItems.$inferSelect): IntakeItemView {
  const original_snapshot = wireSnapshot(row.original_snapshot);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    category: row.category,
    client_request_id: row.client_request_id,
    original_snapshot,
    title: row.title,
    body: row.body,
    note: row.note,
    state: row.state,
    version: row.version,
    collected_by: intakeCollector(row.collected_by_type, row.collected_by_id),
    admitted_target_kind: row.admitted_target_kind,
    admitted_target_id: row.admitted_target_id,
    attachment: original_snapshot.origin === "note" ? (original_snapshot.attachment ?? null) : null,
    group_key: row.group_key,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function recordIntakeAudit(
  tx: Executor,
  tenant_id: string,
  actor: IntakeCollector,
  action: (typeof AuditAction)[keyof typeof AuditAction],
  resource_type: string,
  resource_id: string,
  metadata: Record<string, unknown> = {},
) {
  await auditAwait(
    {
      tenant_id,
      ...collectorAuditActor(actor),
      action,
      resource_type,
      resource_id,
      result: "success",
      metadata,
    },
    tx,
  );
}

export async function defaultIntakeCategory(
  tx: Executor,
  tenant_id: string,
  actor: Actor,
): Promise<string> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenant_id}:${actor.kind}:${actor.id}`}))`,
  );
  const rows = await tx
    .select()
    .from(intakeCategoryDefaults)
    .where(
      and(
        eq(intakeCategoryDefaults.tenant_id, tenant_id),
        eq(intakeCategoryDefaults.actor_type, actor.kind),
        eq(intakeCategoryDefaults.actor_id, actor.id),
      ),
    )
    .limit(1)
    .for("update");
  if (rows[0]) return rows[0].category;
  await tx
    .insert(intakeCategoryDefaults)
    .values({
      tenant_id,
      actor_type: actor.kind,
      actor_id: actor.id,
      category: DEFAULT_INTAKE_CATEGORY,
    })
    .onConflictDoNothing();
  return (
    (
      await tx
        .select({ category: intakeCategoryDefaults.category })
        .from(intakeCategoryDefaults)
        .where(
          and(
            eq(intakeCategoryDefaults.tenant_id, tenant_id),
            eq(intakeCategoryDefaults.actor_type, actor.kind),
            eq(intakeCategoryDefaults.actor_id, actor.id),
          ),
        )
        .limit(1)
    )[0]?.category ?? DEFAULT_INTAKE_CATEGORY
  );
}
