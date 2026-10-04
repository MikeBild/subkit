import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { connectors, skills as skillsTable } from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import type { WorkflowDef } from "./types.ts";
import { validateOutputSchemaSuperset } from "./validator.ts";

export async function applySkillSchemaGate(
  tenant_id: string,
  def: WorkflowDef,
  exec: Executor,
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const skillId = (def as { derived_from_skill_id?: string | null }).derived_from_skill_id;
  if (!skillId) return { ok: true };
  const rows = await exec
    .select({ output_schema: skillsTable.output_schema })
    .from(skillsTable)
    .where(and(eq(skillsTable.tenant_id, tenant_id), eq(skillsTable.slug, skillId)))
    .limit(1);
  const skillSchema = rows[0]?.output_schema ?? null;
  const result = validateOutputSchemaSuperset(skillSchema, def.output_schema ?? null);
  if (result.ok) return { ok: true };
  log.workflow.validation.failed({
    tenant_id,
    op: "skill_gate",
    error_count: result.missing_fields.length,
    first_error: `output_schema missing required fields from skill ${skillId}: ${result.missing_fields.join(", ")}`,
  });
  return {
    ok: false,
    errors: [
      `skill_schema_gate: workflow.output_schema is missing fields required by derived_from_skill_id=${skillId}: ${result.missing_fields.join(", ")}`,
    ],
  };
}

export async function applyStorageBindingGate(
  tenant_id: string,
  def: WorkflowDef,
  exec: Executor,
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const s3Steps = def.steps.filter(
    (s): s is Extract<WorkflowDef["steps"][number], { kind: "request" }> =>
      s.kind === "request" && (s as { s3?: unknown }).s3 !== undefined,
  );
  if (s3Steps.length === 0) return { ok: true };
  const errors: string[] = [];
  const referencedIds = [
    ...new Set(s3Steps.map((s) => s.connector_id).filter((id): id is string => Boolean(id))),
  ];
  const rows =
    referencedIds.length > 0
      ? await exec
          .select({
            id: connectors.id,
            slug: connectors.slug,
            driver: connectors.driver,
            config: connectors.config,
          })
          .from(connectors)
          .where(
            and(
              eq(connectors.tenant_id, tenant_id),
              inArray(connectors.id, referencedIds),
              isNull(connectors.deleted_at),
            ),
          )
      : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const step of s3Steps) {
    if (!step.connector_id) {
      errors.push(
        `steps.${step.id}: s3 step has no connector_id — the S3 driver resolves bucket/region/credentials from a saved s3 connector`,
      );
      continue;
    }
    const connector = byId.get(step.connector_id);
    if (!connector) {
      errors.push(
        `steps.${step.id}: s3 storage binding does not resolve — connector ${step.connector_id} not found for this tenant`,
      );
      continue;
    }
    if (connector.driver !== "s3") {
      errors.push(
        `steps.${step.id}: s3 storage binding does not resolve — connector "${connector.slug}" has driver "${connector.driver}", expected "s3"`,
      );
      continue;
    }
    const bucket = (connector.config as Record<string, unknown> | null)?.bucket;
    if (typeof bucket !== "string" || bucket.length === 0) {
      errors.push(
        `steps.${step.id}: s3 connector "${connector.slug}" has no config.bucket — every S3 operation would fail at runtime (drivers/s3.ts requires it)`,
      );
    }
  }
  if (errors.length === 0) return { ok: true };
  log.workflow.validation.failed({
    tenant_id,
    op: "storage_binding_gate",
    error_count: errors.length,
    first_error: errors[0] ?? null,
  });
  return { ok: false, errors };
}
