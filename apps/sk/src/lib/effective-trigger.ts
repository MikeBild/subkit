// One line naming what really starts a workflow, read from the engine's
// `effective_trigger` + `schedule` fields — never from the definition's
// `trigger`, which says only what was declared. A schedule created with
// `sk schedules create` lives in the binding alone; a declared schedule with
// no binding fires nothing.

import type { components } from "@cli-core/engine-api/openapi.d.ts";

type EffectiveTrigger = components["schemas"]["EffectiveTrigger"];
type ScheduleBinding = components["schemas"]["WorkflowScheduleBinding"];

export interface TriggerFields {
  effective_trigger?: EffectiveTrigger | null;
  schedule?: ScheduleBinding | null;
  webhooks_active?: number;
}

export function effectiveTriggerLabel(item: TriggerFields): string {
  const t = item.effective_trigger;
  if (!t) return "request";
  if (t.state === "declared_unbound") return `${t.kind} declared, not bound`;
  if (t.kind === "schedule") {
    const s = item.schedule;
    const when = s ? ` ${s.cron} ${s.timezone}` : "";
    const suffix = t.state === "active" ? "" : ` (${t.state})`;
    return `schedule${when}${suffix}`;
  }
  if (t.kind === "webhook") return `webhook (${item.webhooks_active ?? 0} active)`;
  return "request";
}
