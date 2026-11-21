import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type * as webpush from "web-push";
import { z } from "zod";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";
import {
  type CockpitPushAudienceRow,
  type CockpitPushTarget,
  cockpitPushPayload,
  listCockpitPushAudience,
} from "../identity/index.ts";
import { activeApprover } from "../identity/setup-preferences.ts";
import { type AttentionV1, buildAttention } from "../operator/attention.ts";
import type { AttentionReaderOverrides } from "../operator/attention-readers.ts";
import { isOwnPairRequest } from "../operator/pair-approval-attention.ts";
import { now } from "../utils/clock.ts";
import {
  autoPauseNoticeCapped,
  isAutoPause,
  markAutoPauseNotified,
  pausedSummary,
} from "./auto-pause-cap.ts";
import {
  cockpitPushSubject,
  deliverCockpitPush,
  logCockpitPushDispatchFailure,
} from "./cockpit-push.ts";
import { claimDigest, releaseDigest } from "./digest-claim.ts";
import { deliverableNow, personalDelivery } from "./personal-schedule.ts";
import { delegatedApprovalItems, itemsKeptByRequester, pushPrincipal } from "./push-delegation.ts";
import {
  buildPushSummary,
  newestItem,
  type PushSummaryMode,
  pushSummaryMode,
  summarizesPush,
} from "./push-summary.ts";

const ATTENTION_KEYS_MAX = 200;
const NotifiedKeys = z
  .array(z.string().regex(/^[0-9a-f]{64}$/))
  .max(ATTENTION_KEYS_MAX)
  .nullable();

interface CockpitPushAttentionOptions {
  now?: Date;
  readers?: AttentionReaderOverrides;
  attention?: (
    principal: ResolvedPrincipal,
  ) => Promise<Pick<AttentionV1, "items"> & { sources?: Partial<AttentionV1["sources"]> }>;
  send?: typeof webpush.sendNotification;
  subject?: string | null;
}

interface CockpitPushAttentionResult {
  notified: number;
  delivered: number;
}

type AttentionItems = AttentionV1["items"];

const OPAQUE_ATTENTION_ID = /^[a-z][a-z_-]{0,31}(?::[A-Za-z0-9_.-]{1,64})?$/;
const COCKPIT_HREF = /^\/cockpit[A-Za-z0-9/_.~?=&%:#-]{0,500}$/;

function attentionKey(item: AttentionItems[number]): string {
  return createHash("sha256").update(`${item.id}|${item.class}|${item.reason}`).digest("hex");
}

function cockpitPushAttentionKeys(items: AttentionItems): string[] {
  return [...new Set(items.map(attentionKey))].sort().slice(0, ATTENTION_KEYS_MAX);
}

function pushTarget(item: AttentionItems[number]): CockpitPushTarget {
  const href = (item.actions.find((action) => action.primary) ?? item.actions[0])?.href;
  return {
    id: item.id,
    class: item.class,
    severity: item.severity,
    href: href && COCKPIT_HREF.test(href) ? href : null,
  };
}

export function cockpitPushAttentionPayload(
  items: AttentionItems,
  notified: ReadonlySet<string>,
): string {
  const fresh = items.filter((item) => !notified.has(attentionKey(item)));
  const targets = fresh.filter((item) => OPAQUE_ATTENTION_ID.test(item.id)).map(pushTarget);
  return cockpitPushPayload(targets, fresh.length - targets.length, pausedSummary(fresh));
}

export function cockpitPushSummaryPayload(
  items: AttentionItems,
  notified: ReadonlySet<string>,
): string {
  const fresh = items.filter((item) => !notified.has(attentionKey(item)));
  const newest = newestItem(fresh.filter((item) => OPAQUE_ATTENTION_ID.test(item.id)));
  const targets = newest ? [pushTarget(newest)] : [];
  return cockpitPushPayload(targets, fresh.length - targets.length, buildPushSummary(fresh));
}

function storedKeys(value: string[] | null): string[] {
  const parsed = NotifiedKeys.safeParse(value);
  return parsed.success ? (parsed.data ?? []) : [];
}

function textArrayLiteral(values: string[]): string {
  return `{${values.map((value) => `"${value.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;
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
  payload: string;
  auto_pause: boolean;
}

interface ClaimAttempt {
  claim: AttentionClaim | null;
  pending: boolean;
}

async function claimNewAttention(
  db: Db,
  tenantId: string,
  row: CockpitPushAudienceRow,
  current: string[],
  partial: boolean,
  items: AttentionItems,
  summary: PushSummaryMode = null,
): Promise<ClaimAttempt> {
  const previous = storedKeys(row.notified_attention_keys);
  const known = new Set(previous);
  const fresh = current.filter((key) => !known.has(key)).length;
  const keys = partial
    ? [...new Set([...previous, ...current])].sort().slice(0, ATTENTION_KEYS_MAX)
    : current;
  if (fresh === 0 && previous.join() === keys.join() && row.notified_attention_keys !== null)
    return { claim: null, pending: false };
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
  const won = claimed.length > 0 && fresh > 0;
  return {
    pending: fresh > 0,
    claim: won
      ? {
          row,
          keys,
          fresh,
          payload: summarizesPush(summary, row.notified_at, fresh)
            ? cockpitPushSummaryPayload(items, known)
            : cockpitPushAttentionPayload(items, known),
          auto_pause: items.some((item) => isAutoPause(item) && !known.has(attentionKey(item))),
        }
      : null,
  };
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
      const principal = await pushPrincipal(
        db,
        tenantId,
        first.user_id,
        first.kind === "installation" ? first.installation_id : null,
      );
      if (!principal) continue;
      const owner = { tenant_id: tenantId, user_id: principal.id };
      const delivery = await personalDelivery(db, owner, at);
      const held = delivery.held;
      if (held && !delivery.critical_breakthrough) continue;
      const attentionOf = (viewer: ResolvedPrincipal) =>
        opts.attention
          ? opts.attention(viewer)
          : buildAttention(db, viewer, {
              now: at,
              ...(opts.readers ? { readers: opts.readers } : {}),
            });
      const attention = await attentionOf(principal);
      const approver = await activeApprover(db, owner);
      const own = await itemsKeptByRequester(
        db,
        tenantId,
        approver ? await pushPrincipal(db, tenantId, approver.user_id) : null,
        attention.items,
      );
      const seen = new Set(own.map((item) => item.id));
      const forwarded = (
        await delegatedApprovalItems(db, tenantId, principal, async (viewer) => {
          return (await attentionOf(viewer)).items;
        })
      ).filter((item) => !seen.has(item.id));
      const due = [...own, ...forwarded].filter((item) => !isOwnPairRequest(item));
      const capped = await autoPauseNoticeCapped(
        db,
        tenantId,
        rows.map((row) => row.id),
        at,
      );
      const items = deliverableNow(delivery, due).filter((item) => !(capped && isAutoPause(item)));
      const keys = cockpitPushAttentionKeys(items);
      const partial = held || capped || Object.values(attention.sources ?? {}).includes("failed");
      const digest = delivery.digest;
      const digestBefore = delivery.preference.last_digest_at;
      const summary = pushSummaryMode(delivery, at);
      if (digest && !(await claimDigest(db, owner, digestBefore, at))) continue;
      const claims: AttentionClaim[] = [];
      let lostRace = false;
      for (const row of rows) {
        const attempt = await claimNewAttention(db, tenantId, row, keys, partial, items, summary);
        lostRace ||= attempt.pending && !attempt.claim;
        if (attempt.claim) claims.push(attempt.claim);
      }
      if (claims.length === 0) {
        if (digest && lostRace) await releaseDigest(db, owner, digestBefore, at);
        continue;
      }
      const settled = new Set<string>();
      try {
        const result = await deliverCockpitPush({
          db,
          tenant_id: tenantId,
          subscription_ids: claims.map((claim) => claim.row.id),
          payloads: new Map(claims.map((claim) => [claim.row.id, claim.payload])),
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
      if (digest && settled.size === 0) await releaseDigest(db, owner, digestBefore, at);
      await markAutoPauseNotified(
        db,
        tenantId,
        claims
          .filter((claim) => claim.auto_pause && settled.has(claim.row.id))
          .map((claim) => claim.row.id),
        at,
      );
      outcome.notified += claims.length;
    }
  } catch (error) {
    logCockpitPushDispatchFailure(tenantId, error);
  }
  return outcome;
}
