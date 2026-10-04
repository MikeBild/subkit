import type { components } from "@/api/schema";
import { absolute, connectorHref } from "@/app/links";
import type { TranslationKey } from "@/lib/i18n";

type EffectiveTrigger = components["schemas"]["EffectiveTrigger"];

export function connectorSlugHref(
  slug: string,
  slugToId: ReadonlyMap<string, string>,
): string | null {
  const id = slugToId.get(slug);
  return id ? absolute(connectorHref(id)) : null;
}

const ON_REQUEST: TranslationKey = "workflows.trigger.request";

export function triggerLabelKey(trigger: EffectiveTrigger): TranslationKey {
  if (trigger.kind === "schedule") {
    switch (trigger.state) {
      case "paused":
        return "workflows.trigger.schedulePaused";
      case "held":
        return "workflows.trigger.scheduleHeld";
      case "activation_required":
        return "workflows.trigger.scheduleInactive";
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
