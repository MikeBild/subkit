import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

type WorkflowTrigger = components["schemas"]["WorkflowTrigger"];

/**
 * A workflow list item names the connectors it uses by **slug**; the connector
 * detail route needs an **id**. The page inverts one `/v1/connectors` read into
 * this map rather than resolving each row on its own.
 *
 * A slug the map does not know renders as plain text. A link to nowhere is
 * worse than a word.
 */
export function connectorHref(slug: string, slugToId: ReadonlyMap<string, string>): string | null {
  const id = slugToId.get(slug);
  return id ? `/cockpit/connectors/${encodeURIComponent(id)}` : null;
}

const ON_REQUEST: TranslationKey = "workflows.trigger.request";

const TRIGGER_KEYS: Record<string, TranslationKey | undefined> = {
  request: ON_REQUEST,
  webhook: "workflows.trigger.webhook",
  schedule: "workflows.trigger.schedule",
};

/**
 * No trigger means the workflow runs when something asks it to, which is the
 * request trigger — not an unknown state. "Unknown" would be a claim the
 * engine never made.
 */
export function triggerLabelKey(trigger: WorkflowTrigger | null | undefined): TranslationKey {
  if (!trigger) return ON_REQUEST;
  return TRIGGER_KEYS[trigger.kind] ?? ON_REQUEST;
}
