import { and, desc, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { decryptSecret, encryptSecret } from "../../crypto/aes-gcm.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Executor } from "../../db/client.ts";
import { subscriptions } from "../../db/schema/index.ts";

function aadFor(tenant_id: string, id: string): string {
  return `subscription:${tenant_id}:${id}`;
}

function toBuf(u: Uint8Array): Buffer {
  return Buffer.from(u);
}

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  event_pattern: string;
  target_url: string;
  active: boolean;
  circuit_open_until: Date | null;
  consecutive_failures: number;
  created_at: Date;
  updated_at: Date;
}

function serialize(row: typeof subscriptions.$inferSelect): SubscriptionRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    event_pattern: row.event_pattern,
    target_url: row.target_url,
    active: row.active,
    circuit_open_until: row.circuit_open_until ?? null,
    consecutive_failures: row.consecutive_failures ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateSubscriptionInput {
  tenant_id: string;
  actor_id: string | null;
  event_pattern: string;
  target_url: string;
  secret: string;
  active?: boolean;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
  exec?: Executor,
): Promise<SubscriptionRow> {
  const db = exec ?? (undefined as never);
  const runner = db ?? undefined;
  const target = runner ?? (await import("../../db/client.ts")).getDb();
  return await target.transaction(async (tx) => {
    const placeholder = encryptSecret("__placeholder__");
    const inserted = await tx
      .insert(subscriptions)
      .values({
        tenant_id: input.tenant_id,
        event_pattern: input.event_pattern,
        target_url: input.target_url,
        secret_ciphertext: toBuf(placeholder.ciphertext),
        secret_iv: toBuf(placeholder.iv),
        secret_auth_tag: toBuf(placeholder.auth_tag),
        active: input.active ?? true,
      })
      .returning();
    const row = inserted[0];
    assertInsertRow(row, "subscription");
    const payload = encryptSecret(input.secret, aadFor(input.tenant_id, row.id));
    const updated = await tx
      .update(subscriptions)
      .set({
        secret_ciphertext: toBuf(payload.ciphertext),
        secret_iv: toBuf(payload.iv),
        secret_auth_tag: toBuf(payload.auth_tag),
        updated_at: new Date(),
      })
      .where(eq(subscriptions.id, row.id))
      .returning();
    const final = updated[0] ?? row;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.SUBSCRIPTION_CREATED,
        resource_type: "subscription",
        resource_id: row.id,
        result: "success",
        metadata: {
          event_pattern: input.event_pattern,
          target_url: input.target_url,
        },
      },
      tx,
    );
    return serialize(final);
  });
}

export async function listSubscriptions(
  tenant_id: string,
  exec?: Executor,
): Promise<SubscriptionRow[]> {
  const db = exec ?? (await import("../../db/client.ts")).getDb();
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.tenant_id, tenant_id))
    .orderBy(desc(subscriptions.created_at));
  return rows.map(serialize);
}

export async function getSubscription(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<SubscriptionRow | null> {
  const db = exec ?? (await import("../../db/client.ts")).getDb();
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.tenant_id, tenant_id), eq(subscriptions.id, id)))
    .limit(1);
  const row = rows[0];
  return row ? serialize(row) : null;
}

export interface DecryptedSubscription {
  row: typeof subscriptions.$inferSelect;
  primary_secret: string;
  rotating_secret: string | null;
}

export async function loadSubscriptionSecrets(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<DecryptedSubscription | null> {
  const db = exec ?? (await import("../../db/client.ts")).getDb();
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.tenant_id, tenant_id), eq(subscriptions.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const primary = decryptSecret(
    {
      ciphertext: row.secret_ciphertext,
      iv: row.secret_iv,
      auth_tag: row.secret_auth_tag,
    },
    aadFor(tenant_id, row.id),
  );
  let rotating: string | null = null;
  if (row.rotating_secret_ciphertext && row.rotating_secret_iv && row.rotating_secret_auth_tag) {
    rotating = decryptSecret(
      {
        ciphertext: row.rotating_secret_ciphertext,
        iv: row.rotating_secret_iv,
        auth_tag: row.rotating_secret_auth_tag,
      },
      aadFor(tenant_id, row.id),
    );
  }
  return { row, primary_secret: primary, rotating_secret: rotating };
}

export interface UpdateSubscriptionInput {
  tenant_id: string;
  id: string;
  actor_id: string | null;
  event_pattern?: string;
  target_url?: string;
  active?: boolean;
  secret?: string;
  rotating_secret?: string | null;
}

export async function updateSubscription(
  input: UpdateSubscriptionInput,
  exec?: Executor,
): Promise<SubscriptionRow | null> {
  const db = exec ?? (await import("../../db/client.ts")).getDb();
  return await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.tenant_id, input.tenant_id), eq(subscriptions.id, input.id)))
      .limit(1);
    const row = existing[0];
    if (!row) return null;

    const patch: Partial<typeof subscriptions.$inferInsert> = { updated_at: new Date() };
    if (input.event_pattern !== undefined) patch.event_pattern = input.event_pattern;
    if (input.target_url !== undefined) patch.target_url = input.target_url;
    if (input.active !== undefined) patch.active = input.active;
    if (input.secret !== undefined) {
      const payload = encryptSecret(input.secret, aadFor(input.tenant_id, row.id));
      patch.secret_ciphertext = toBuf(payload.ciphertext);
      patch.secret_iv = toBuf(payload.iv);
      patch.secret_auth_tag = toBuf(payload.auth_tag);
    }
    if (input.rotating_secret !== undefined) {
      if (input.rotating_secret === null) {
        patch.rotating_secret_ciphertext = null;
        patch.rotating_secret_iv = null;
        patch.rotating_secret_auth_tag = null;
      } else {
        const payload = encryptSecret(input.rotating_secret, aadFor(input.tenant_id, row.id));
        patch.rotating_secret_ciphertext = toBuf(payload.ciphertext);
        patch.rotating_secret_iv = toBuf(payload.iv);
        patch.rotating_secret_auth_tag = toBuf(payload.auth_tag);
      }
    }

    const updated = await tx
      .update(subscriptions)
      .set(patch)
      .where(eq(subscriptions.id, input.id))
      .returning();
    const final = updated[0];
    if (!final) return null;

    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.SUBSCRIPTION_UPDATED,
        resource_type: "subscription",
        resource_id: input.id,
        result: "success",
        metadata: {
          fields: Object.keys(patch).filter((k) => k !== "updated_at"),
        },
      },
      tx,
    );
    return serialize(final);
  });
}

export async function deleteSubscription(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  exec?: Executor,
): Promise<boolean> {
  const db = exec ?? (await import("../../db/client.ts")).getDb();
  const result = await db
    .delete(subscriptions)
    .where(and(eq(subscriptions.tenant_id, tenant_id), eq(subscriptions.id, id)));
  const ok = (result as { rowCount?: number }).rowCount
    ? ((result as { rowCount?: number }).rowCount ?? 0) > 0
    : true;
  if (ok) {
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.SUBSCRIPTION_DELETED,
        resource_type: "subscription",
        resource_id: id,
        result: "success",
        metadata: {},
      },
      db,
    );
  }
  return ok;
}
