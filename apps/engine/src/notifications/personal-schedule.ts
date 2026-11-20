import type { Executor } from "../db/client.ts";
import { type PushPreference, readPushPreference } from "../identity/setup-preferences.ts";
import { type CriticalCandidate, decidePush, isCriticalPush } from "./quiet-hours.ts";

export const PERSONAL_SCHEDULE_CHANNELS = {
  cockpit_push: "applies",
  cockpit_stream: "applies",
  cli_inbox: "shared_store",
  chat_channel: "shared_channel",
  outbound_webhook: "machine",
} as const;

export type NotificationChannelKind = keyof typeof PERSONAL_SCHEDULE_CHANNELS;

export function personalScheduleApplies(channel: NotificationChannelKind): boolean {
  return PERSONAL_SCHEDULE_CHANNELS[channel] === "applies";
}

export interface PersonalDelivery {
  readonly held: boolean;
  readonly digest: boolean;
  readonly next_delivery: Date | null;
  readonly critical_breakthrough: boolean;
  readonly preference: PushPreference;
}

export function deliveryOf(preference: PushPreference, at: Date): PersonalDelivery {
  const decision = decidePush({
    schedule: preference.schedule,
    timezone: preference.timezone,
    now: at,
    last_digest_at: preference.last_digest_at,
  });
  return decision.deliver === "held"
    ? {
        held: true,
        digest: false,
        next_delivery: decision.next_delivery,
        critical_breakthrough: preference.critical_breakthrough,
        preference,
      }
    : {
        held: false,
        digest: decision.digest,
        next_delivery: null,
        critical_breakthrough: preference.critical_breakthrough,
        preference,
      };
}

export async function personalDelivery(
  db: Executor,
  owner: { readonly tenant_id: string; readonly user_id: string },
  at: Date,
): Promise<PersonalDelivery> {
  return deliveryOf(await readPushPreference(db, owner), at);
}

export function deliverableNow<T extends CriticalCandidate>(
  delivery: Pick<PersonalDelivery, "held" | "critical_breakthrough">,
  items: readonly T[],
): T[] {
  if (!delivery.held) return [...items];
  return delivery.critical_breakthrough ? items.filter(isCriticalPush) : [];
}

export type StreamDeliveryHint = "held" | "critical_only" | null;

export function streamDeliveryHint(
  delivery: Pick<PersonalDelivery, "held" | "critical_breakthrough">,
): StreamDeliveryHint {
  if (!delivery.held) return null;
  return delivery.critical_breakthrough ? "critical_only" : "held";
}
