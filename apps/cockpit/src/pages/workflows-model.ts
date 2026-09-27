import type { components } from "@/api/schema";
import { absolute, connectorHref } from "@/app/links";
import type { TranslationKey } from "@/lib/i18n";

type EffectiveTrigger = components["schemas"]["EffectiveTrigger"];

/**
 * A workflow list item names the connectors it uses by **slug**; the connector
 * detail route needs an **id**. The page inverts one `/v1/connectors` read into
 * this map rather than resolving each row on its own.
 *
 * A slug the map does not know renders as plain text. A link to nowhere is
 * worse than a word.
 */
export function connectorSlugHref(
  slug: string,
  slugToId: ReadonlyMap<string, string>,
): string | null {
  const id = slugToId.get(slug);
  return id ? absolute(connectorHref(id)) : null;
}

const ON_REQUEST: TranslationKey = "workflows.trigger.request";

/**
 * The word for what really starts a workflow, read from the engine's
 * `effective_trigger` — never from the definition's `trigger`. A schedule set
 * up on its own lives only in the schedule binding; reading the definition
 * called such a workflow "Auf Anfrage" while it fired every hour.
 *
 * A schedule or webhook that is declared but not bound fires nothing, so it
 * must not read as "Zeitplan": its word says it runs on request only. Paused
 * and held schedules keep their own words for the same reason.
 *
 * No effective trigger (an older engine) is the request default, not an
 * unknown state — "unknown" would be a claim the engine never made.
 */
export function triggerLabelKey(trigger: EffectiveTrigger | null | undefined): TranslationKey {
  if (!trigger) return ON_REQUEST;
  if (trigger.kind === "schedule") {
    switch (trigger.state) {
      case "paused":
        return "workflows.trigger.schedulePaused";
      case "held":
        return "workflows.trigger.scheduleHeld";
      case "declared_unbound":
        return "workflows.trigger.scheduleUnbound";
      default:
        return "workflows.trigger.schedule";
    }
  }
  if (trigger.kind === "webhook") {
    return trigger.state === "declared_unbound"
      ? "workflows.trigger.webhookUnbound"
      : "workflows.trigger.webhook";
  }
  return ON_REQUEST;
}
