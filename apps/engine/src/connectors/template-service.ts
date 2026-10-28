import { and, asc, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import { connectorTemplates } from "../db/schema/index.ts";

type TemplateRow = typeof connectorTemplates.$inferSelect;

export type TenantConnectorTemplateInput = Omit<
  typeof connectorTemplates.$inferInsert,
  "id" | "tenant_id" | "version" | "created_at" | "updated_at"
>;

export interface CreateTenantConnectorTemplateParams {
  tenant_id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
  input: TenantConnectorTemplateInput;
  audit_metadata?: Record<string, unknown>;
}

export async function createTenantConnectorTemplate(
  p: CreateTenantConnectorTemplateParams,
  exec: Executor = getDb(),
): Promise<TemplateRow> {
  const [row] = await exec
    .insert(connectorTemplates)
    .values({ ...p.input, tenant_id: p.tenant_id, version: 1 })
    .returning();
  assertInsertRow(row, "connector_templates");
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_type,
      actor_id: p.actor_id,
      action: AuditAction.CONNECTOR_CREATED,
      resource_type: "connector_template",
      resource_id: row.id,
      result: "success",
      metadata: { slug: row.slug, source: "tenant_override", ...p.audit_metadata },
    },
    exec,
  );
  return row;
}

export async function listTenantConnectorTemplates(
  tenant_id: string,
  exec: Executor = getDb(),
): Promise<TemplateRow[]> {
  return exec
    .select()
    .from(connectorTemplates)
    .where(eq(connectorTemplates.tenant_id, tenant_id))
    .orderBy(asc(connectorTemplates.slug));
}

export async function getTenantConnectorTemplateBySlug(
  tenant_id: string,
  slug: string,
  exec: Executor = getDb(),
): Promise<TemplateRow | null> {
  const [row] = await exec
    .select()
    .from(connectorTemplates)
    .where(and(eq(connectorTemplates.tenant_id, tenant_id), eq(connectorTemplates.slug, slug)))
    .limit(1);
  return row ?? null;
}
