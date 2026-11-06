import { and, eq } from "drizzle-orm";
import { writeAudit } from "../db/audit.ts";
import type { Db } from "../db/client.ts";
import { requestHooks } from "../db/schema/request_hooks.ts";
import { STDLIB_VERSION } from "../sandboxes/index.ts";
import type { ResolvedPrincipal } from "./types.ts";

export type RequestHookRow = typeof requestHooks.$inferSelect;

export interface RequestHookActor {
  principal: Pick<ResolvedPrincipal, "tenant_id" | "kind" | "id">;
  trace_id: string;
}

export interface CreateRequestHookInput {
  role: string;
  code: string;
  description?: string | undefined;
  enabled?: boolean | undefined;
}

export interface UpdateRequestHookInput {
  code?: string | undefined;
  description?: string | undefined;
  enabled?: boolean | undefined;
}

async function auditHookChange(
  db: Db,
  actor: RequestHookActor,
  row: RequestHookRow,
  change: { before: unknown; after: unknown; reason: string },
): Promise<void> {
  await writeAudit(
    {
      id: crypto.randomUUID(),
      ts: new Date(),
      tenant_id: actor.principal.tenant_id,
      actor_type: actor.principal.kind,
      actor_id: actor.principal.id,
      action: "before_request_hook.changed",
      resource_type: "request_hook",
      resource_id: row.id,
      result: "success",
      trace_id: actor.trace_id,
      ip: null,
      user_agent: null,
      before: change.before,
      after: change.after,
      reason: change.reason,
      metadata: {},
    },
    db,
  );
}

export async function listRequestHooks(db: Db, tenantId: string): Promise<RequestHookRow[]> {
  return db.select().from(requestHooks).where(eq(requestHooks.tenant_id, tenantId));
}

export async function findRequestHook(
  db: Db,
  tenantId: string,
  id: string,
): Promise<RequestHookRow | null> {
  const existing = await db
    .select()
    .from(requestHooks)
    .where(and(eq(requestHooks.tenant_id, tenantId), eq(requestHooks.id, id)));
  return existing[0] ?? null;
}

export async function createRequestHook(
  db: Db,
  actor: RequestHookActor,
  input: CreateRequestHookInput,
): Promise<RequestHookRow> {
  const [row] = await db
    .insert(requestHooks)
    .values({
      tenant_id: actor.principal.tenant_id,
      role: input.role,
      source: input.code,
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      updated_by: actor.principal.id,
      stdlib_version: STDLIB_VERSION,
    })
    .returning();
  if (!row) throw new Error("insert failed");
  await auditHookChange(db, actor, row, {
    before: null,
    after: { role: row.role, version: row.version, enabled: row.enabled },
    reason: "created",
  });
  return row;
}

export async function updateRequestHook(
  db: Db,
  actor: RequestHookActor,
  cur: RequestHookRow,
  input: UpdateRequestHookInput,
): Promise<RequestHookRow | null> {
  const tenantId = actor.principal.tenant_id;
  const updates: Partial<typeof requestHooks.$inferInsert> = {
    updated_at: new Date(),
    updated_by: actor.principal.id,
  };
  if (input.code !== undefined) {
    updates.source = input.code;
    updates.version = cur.version + 1;
    updates.stdlib_version = STDLIB_VERSION;
  }
  if (input.description !== undefined) updates.description = input.description;
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  const [row] = await db
    .update(requestHooks)
    .set(updates)
    .where(and(eq(requestHooks.tenant_id, tenantId), eq(requestHooks.id, cur.id)))
    .returning();
  if (!row) return null;
  await auditHookChange(db, actor, row, {
    before: { version: cur.version, enabled: cur.enabled },
    after: { version: row.version, enabled: row.enabled },
    reason: "updated",
  });
  return row;
}

export async function deleteRequestHook(
  db: Db,
  actor: RequestHookActor,
  id: string,
): Promise<RequestHookRow | null> {
  const tenantId = actor.principal.tenant_id;
  const [row] = await db
    .delete(requestHooks)
    .where(and(eq(requestHooks.tenant_id, tenantId), eq(requestHooks.id, id)))
    .returning();
  if (!row) return null;
  await auditHookChange(db, actor, row, {
    before: { role: row.role, version: row.version },
    after: null,
    reason: "deleted",
  });
  return row;
}
