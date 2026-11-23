import type { Translate } from "@/lib/i18n";
import { toolLabel } from "@/lib/tool-presentation";
import type { ActivityLine, ActivityStep } from "./activity";
import { backgroundLabel } from "./labels";

export interface ActivityNames {
  connectorName: (id: string) => string | null;
  workflowName: (slug: string) => string | null;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function stepSentence(t: Translate, step: ActivityStep, names: ActivityNames): string {
  const label = toolLabel(step.tool);
  if (label.kind === "workflow")
    return t("chat.activity.step.workflow", {
      name: names.workflowName(label.slug) ?? label.slug,
    });
  const connector = step.connectorId ? names.connectorName(step.connectorId) : null;
  if (connector) {
    const writes = step.method !== null && WRITE_METHODS.has(step.method);
    if (step.resource)
      return t(writes ? "chat.activity.step.writesResource" : "chat.activity.step.readsResource", {
        resource: step.resource,
        connector,
      });
    return t(writes ? "chat.activity.step.writes" : "chat.activity.step.reads", { connector });
  }
  return backgroundLabel(t, step.tool, true);
}

export function activitySentence(t: Translate, line: ActivityLine, names: ActivityNames): string {
  const head =
    line.now.kind === "tool"
      ? stepSentence(t, line.now.step, names)
      : t(line.now.kind === "writing" ? "chat.activity.responding" : "chat.activity.model");
  if (!line.retry) return head;
  return t("chat.activity.retry", {
    step: head,
    attempt: String(line.retry.attempt),
    of: String(line.retry.of),
  });
}

export function stepOutcomeKey(
  step: ActivityStep,
): "chat.activity.history.ok" | "chat.activity.history.failed" | "chat.activity.history.running" {
  if (step.endedAt === null) return "chat.activity.history.running";
  return step.ok === false ? "chat.activity.history.failed" : "chat.activity.history.ok";
}
