import type { ExecutionRunDraftDefinition } from "../engine-client/executions.ts";
import type { CreateWorkflowRequest } from "../engine-client/workflows.ts";
import type { WorkflowIntent, WorkflowTrigger } from "../render/types.ts";

function parseTrigger(raw: unknown): WorkflowTrigger {
  if (raw && typeof raw === "object") {
    const t = raw as Record<string, unknown>;
    if (t.kind === "schedule") {
      return {
        kind: "schedule",
        cron: typeof t.cron === "string" ? t.cron : "?",
        tz: typeof t.tz === "string" ? t.tz : "UTC",
      };
    }
    if (t.kind === "webhook") {
      return {
        kind: "webhook",
        source: typeof t.source === "string" ? t.source : "?",
        events: Array.isArray(t.events) ? t.events.filter((e) => typeof e === "string") : [],
      };
    }
  }
  return { kind: "request" };
}

export function intentFromBody(body: Record<string, unknown>): WorkflowIntent {
  const definition =
    Array.isArray(body.steps) || body.trigger !== undefined
      ? body
      : ((body.definition as Record<string, unknown>) ?? {});
  const rawSteps = Array.isArray(definition.steps) ? definition.steps : [];
  const steps = rawSteps.map((s) => {
    const r = (s ?? {}) as Record<string, unknown>;
    return {
      key: typeof r.key === "string" ? r.key : typeof r.id === "string" ? r.id : "(step)",
      kind: typeof r.kind === "string" ? r.kind : "step",
    };
  });
  return {
    kind: "workflow",
    name: typeof body.name === "string" ? body.name : "(workflow)",
    ...(typeof body.slug === "string" ? { slug: body.slug } : {}),
    trigger: parseTrigger(definition.trigger),
    steps,
  };
}

type WorkflowFileDefinition = CreateWorkflowRequest & ExecutionRunDraftDefinition;

function isWorkflowDefinition(body: Record<string, unknown>): body is WorkflowFileDefinition {
  return typeof body.name === "string" && Array.isArray(body.steps);
}

export function workflowDefinition(body: Record<string, unknown>): WorkflowFileDefinition {
  if (isWorkflowDefinition(body)) return body;
  throw new Error("the workflow definition needs a name and a steps array");
}
