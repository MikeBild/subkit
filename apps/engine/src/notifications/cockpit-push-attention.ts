import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type webpush from "web-push";
import { z } from "zod";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";
import { roles, users } from "../db/schema/index.ts";
import { type CockpitPushAudienceRow, listCockpitPushAudience } from "../identity/index.ts";
import { type AttentionV1, buildAttention } from "../operator/attention.ts";
import type { AttentionReaderOverrides } from "../operator/attention-readers.ts";
import { now } from "../utils/clock.ts";
import {
  cockpitPushSubject,
  deliverCockpitPush,
  logCockpitPushDispatchFailure,
} from "./cockpit-push.ts";

const ATTENTION_KEYS_MAX = 200;
const NotifiedKeys = z
  .array(z.string().regex(/^[0-9a-f]{64}$/))
  .max(ATTENTION_KEYS_MAX)
  .nullable();

export interface CockpitPushAttentionOptions {
  now?: Date;
  readers?: AttentionReaderOverrides;
  attention?: (principal: ResolvedPrincipal) => Promise<Pick<AttentionV1, "items">>;
  send?: typeof webpush.sendNotification;
  subject?: string | null;
}

export interface CockpitPushAttentionResult {
  notified: number;
  delivered: number;
}

export function cockpitPushAttentionKeys(items: AttentionV1["items"]): string[] {
  return [
    ...new Set(
      items.map((item) =>
        createHash("sha256").update(`${item.id}|${item.class}|${item.reason}`).digest("hex"),
      ),
    ),
  ]
    .sort()
    .slice(0, ATTENTION_KEYS_MAX);
}

function storedKeys(value: string[] | null): string[] {
  const parsed = NotifiedKeys.safeParse(value);
  return parsed.success ? (parsed.data ?? []) : [];
}

function textArrayLiteral(values: string[]): string {
  return `{${values.map((value) => `"${value.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;
}

async function ownerPrincipal(
  db: Db,
  tenantId: string,
  row: CockpitPushAudienceRow,
): Promise<ResolvedPrincipal | null> {
  const [owner] = await db
    .select({ role_name: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.tenant_id, tenantId), eq(users.id, row.owner_user_id)))
    .limit(1);
  if (!owner) return null;
  return {
    provider: "cockpit_push",
    kind: "user",
    id: row.owner_user_id,
    tenant_id: tenantId,
    roles: owner.role_name ? [owner.role_name] : [],
    installation_id: row.installation_id,
  };
}

async function claimNewAttention(
  db: Db,
  tenantId: string,
  row: CockpitPushAudienceRow,
  keys: string[],
  at: Date,
): Promise<number> {
  const previous = storedKeys(row.notified_attention_keys);
  const known = new Set(previous);
  const fresh = keys.filter((key) => !known.has(key)).length;
  if (fresh === 0 && previous.length === keys.length && row.notified_attention_keys !== null)
    return 0;
  const unchanged =
    row.notified_attention_keys === null
      ? isNull(cockpitPushSubscriptions.notified_attention_keys)
      : sql`${cockpitPushSubscriptions.notified_attention_keys} = ${textArrayLiteral(row.notified_attention_keys)}::text[]`;
  const claimed = await db
    .update(cockpitPushSubscriptions)
    .set({
      notified_attention_keys: keys,
      ...(fresh > 0 ? { notified_at: at } : {}),
    })
    .where(
      and(
        eq(cockpitPushSubscriptions.tenant_id, tenantId),
        eq(cockpitPushSubscriptions.id, row.id),
        unchanged,
      ),
    )
    .returning({ id: cockpitPushSubscriptions.id });
  return claimed.length > 0 ? fresh : 0;
}

export async function dispatchCockpitPushAttention(
  db: Db,
  tenantId: string,
  opts: CockpitPushAttentionOptions = {},
): Promise<CockpitPushAttentionResult> {
  const at = opts.now ?? new Date(now());
  const outcome: CockpitPushAttentionResult = { notified: 0, delivered: 0 };
  try {
    const audience = await listCockpitPushAudience(db, tenantId, at);
    const installations = new Map<string, CockpitPushAudienceRow[]>();
    for (const row of audience)
      installations.set(row.installation_id, [
        ...(installations.get(row.installation_id) ?? []),
        row,
      ]);
    for (const [installationId, rows] of installations) {
      const first = rows[0];
      if (!first) continue;
      const principal = await ownerPrincipal(db, tenantId, first);
      if (!principal) continue;
      const attention = opts.attention
        ? await opts.attention(principal)
        : await buildAttention(db, principal, {
            now: at,
            ...(opts.readers ? { readers: opts.readers } : {}),
          });
      const keys = cockpitPushAttentionKeys(attention.items);
      const claimed: string[] = [];
      let newItems = 0;
      for (const row of rows) {
        const fresh = await claimNewAttention(db, tenantId, row, keys, at);
        if (fresh === 0) continue;
        claimed.push(row.id);
        newItems = Math.max(newItems, fresh);
      }
      if (claimed.length === 0) continue;
      const result = await deliverCockpitPush({
        db,
        tenant_id: tenantId,
        installation_id: installationId,
        subscription_ids: claimed,
        new_items: newItems,
        subject: opts.subject === undefined ? cockpitPushSubject() : opts.subject,
        now: at,
        ...(opts.send ? { send: opts.send } : {}),
      });
      outcome.notified += claimed.length;
      outcome.delivered += result?.delivered ?? 0;
    }
  } catch (error) {
    logCockpitPushDispatchFailure(tenantId, error);
  }
  return outcome;
}
