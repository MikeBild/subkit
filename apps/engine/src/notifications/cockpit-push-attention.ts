import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
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
  attention?: (
    principal: ResolvedPrincipal,
  ) => Promise<Pick<AttentionV1, "items"> & { sources?: Partial<AttentionV1["sources"]> }>;
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
    .where(and(eq(users.tenant_id, tenantId), eq(users.id, row.user_id)))
    .limit(1);
  if (!owner) return null;
  return {
    provider: "cockpit_push",
    kind: "user",
    id: row.user_id,
    tenant_id: tenantId,
    roles: owner.role_name ? [owner.role_name] : [],
    ...(row.kind === "installation" && row.installation_id
      ? { installation_id: row.installation_id }
      : {}),
  };
}

function keysMatch(value: string[] | null): SQL {
  return value === null
    ? isNull(cockpitPushSubscriptions.notified_attention_keys)
    : sql`${cockpitPushSubscriptions.notified_attention_keys} = ${textArrayLiteral(value)}::text[]`;
}

interface AttentionClaim {
  row: CockpitPushAudienceRow;
  keys: string[];
  fresh: number;
}

async function claimNewAttention(
  db: Db,
  tenantId: string,
  row: CockpitPushAudienceRow,
  current: string[],
  partial: boolean,
): Promise<AttentionClaim | null> {
  const previous = storedKeys(row.notified_attention_keys);
  const known = new Set(previous);
  const fresh = current.filter((key) => !known.has(key)).length;
  const keys = partial
    ? [...new Set([...previous, ...current])].sort().slice(0, ATTENTION_KEYS_MAX)
    : current;
  if (fresh === 0 && previous.join() === keys.join() && row.notified_attention_keys !== null)
    return null;
  const claimed = await db
    .update(cockpitPushSubscriptions)
    .set({ notified_attention_keys: keys })
    .where(
      and(
        eq(cockpitPushSubscriptions.tenant_id, tenantId),
        eq(cockpitPushSubscriptions.id, row.id),
        keysMatch(row.notified_attention_keys),
      ),
    )
    .returning({ id: cockpitPushSubscriptions.id });
  return claimed.length > 0 && fresh > 0 ? { row, keys, fresh } : null;
}

async function settleClaims(
  db: Db,
  tenantId: string,
  claims: AttentionClaim[],
  settled: Set<string>,
  at: Date,
): Promise<void> {
  const settledIds = claims
    .filter((claim) => settled.has(claim.row.id))
    .map((claim) => claim.row.id);
  if (settledIds.length > 0)
    await db
      .update(cockpitPushSubscriptions)
      .set({ notified_at: at })
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, tenantId),
          inArray(cockpitPushSubscriptions.id, settledIds),
        ),
      );
  for (const claim of claims.filter((pending) => !settled.has(pending.row.id)))
    await db
      .update(cockpitPushSubscriptions)
      .set({ notified_attention_keys: claim.row.notified_attention_keys })
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, tenantId),
          eq(cockpitPushSubscriptions.id, claim.row.id),
          keysMatch(claim.keys),
        ),
      );
}

export function dedupeSameDeviceAudience(rows: readonly CockpitPushAudienceRow[]): {
  kept: CockpitPushAudienceRow[];
  skipped: CockpitPushAudienceRow[];
} {
  const installedDevices = new Set(
    rows.flatMap((row) =>
      row.kind === "installation" && row.device_sha256
        ? [`${row.user_id}:${row.device_sha256}`]
        : [],
    ),
  );
  const sameDevice = (row: CockpitPushAudienceRow) =>
    row.kind === "browser" &&
    row.device_sha256 !== null &&
    installedDevices.has(`${row.user_id}:${row.device_sha256}`);
  return {
    kept: rows.filter((row) => !sameDevice(row)),
    skipped: rows.filter(sameDevice),
  };
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
    const audienceByUser = new Map<string, CockpitPushAudienceRow[]>();
    for (const row of audience)
      audienceByUser.set(row.user_id, [...(audienceByUser.get(row.user_id) ?? []), row]);
    for (const userRows of audienceByUser.values()) {
      const { kept: rows, skipped } = dedupeSameDeviceAudience(userRows);
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
      const partial = Object.values(attention.sources ?? {}).includes("failed");
      const claims: AttentionClaim[] = [];
      for (const row of rows) {
        const claim = await claimNewAttention(db, tenantId, row, keys, partial);
        if (claim) claims.push(claim);
      }
      if (claims.length === 0) continue;
      const settled = new Set<string>();
      try {
        const result = await deliverCockpitPush({
          db,
          tenant_id: tenantId,
          subscription_ids: claims.map((claim) => claim.row.id),
          new_items: Math.max(...claims.map((claim) => claim.fresh)),
          skipped_same_device: skipped.length,
          subject: opts.subject === undefined ? cockpitPushSubject() : opts.subject,
          now: at,
          ...(opts.send ? { send: opts.send } : {}),
        });
        for (const sent of result?.outcomes ?? [])
          if (sent.status !== "failed") settled.add(sent.subscription_id);
        outcome.delivered += result?.delivered ?? 0;
      } finally {
        await settleClaims(db, tenantId, claims, settled, at);
      }
      outcome.notified += claims.length;
    }
  } catch (error) {
    logCockpitPushDispatchFailure(tenantId, error);
  }
  return outcome;
}
