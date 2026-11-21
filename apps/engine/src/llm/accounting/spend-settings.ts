import { eq } from "drizzle-orm";
import { actorType } from "../../audit/actor.ts";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction, type AuditActionValue } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { now } from "../../utils/clock.ts";
import { spendWorkspace } from "./spend.ts";

interface SpendChange {
  set: Partial<typeof tenants.$inferInsert>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  action: AuditActionValue;
  source: string;
}

async function changeSpend(
  db: Db,
  principal: ResolvedPrincipal,
  change: SpendChange,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(tenants)
      .set({
        ...change.set,
        spend_limit_changed_by: principal.kind === "user" ? principal.id : null,
      })
      .where(eq(tenants.id, principal.tenant_id));
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: change.action,
        resource_type: "tenant",
        resource_id: principal.tenant_id,
        result: "success",
        before: change.before,
        after: change.after,
        metadata: { request_source: change.source },
      },
      tx,
    );
  });
}

export async function writeSpendLimit(
  db: Db,
  principal: ResolvedPrincipal,
  limit_usd: number,
  source: string,
): Promise<void> {
  const current = await spendWorkspace(db, principal.tenant_id);
  await changeSpend(db, principal, {
    set: { spend_limit_usd: limit_usd, spend_limit_chosen_at: new Date(now()) },
    before: { limit_usd: current.limit_usd, chosen: current.chosen },
    after: { limit_usd },
    action: AuditAction.WORKSPACE_SPEND_LIMIT_CHANGED,
    source,
  });
}

export async function continueSpendMonth(
  db: Db,
  principal: ResolvedPrincipal,
  month: string,
  source: string,
): Promise<void> {
  const current = await spendWorkspace(db, principal.tenant_id);
  await changeSpend(db, principal, {
    set: { spend_continue_month: month },
    before: { continue_month: current.continue_month || null },
    after: { continue_month: month },
    action: AuditAction.WORKSPACE_SPEND_CONTINUED,
    source,
  });
}
