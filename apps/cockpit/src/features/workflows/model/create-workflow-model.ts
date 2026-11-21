import type { components } from "@cli-core/engine-api/openapi";

type WorkflowDef = components["schemas"]["WorkflowDef"];

export type WorkflowTrigger = "webhook" | "schedule" | "request";

export function manualWorkflowDefinition(p: {
  name: string;
  slug: string;
  purpose: string;
  trigger: WorkflowTrigger;
  schedule: () => { cron: string; timezone: string };
}): WorkflowDef {
  return {
    name: p.name.trim(),
    slug: p.slug,
    ...(p.purpose.trim() ? { description: p.purpose.trim() } : {}),
    steps: [{ id: "start", kind: "transform", expression: "return input;" }],
    trigger:
      p.trigger === "schedule"
        ? { kind: "schedule", cron: p.schedule().cron, tz: p.schedule().timezone }
        : p.trigger === "webhook"
          ? { kind: "webhook", source: p.slug, events: [], verify: "none" }
          : { kind: "request" },
  };
}
