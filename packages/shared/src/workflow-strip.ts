import type { AutomationAction, AutomationState } from "./workflow-automation.ts";

export type StripKind =
  | "loading"
  | "failed"
  | "invalid"
  | "disabled"
  | "empty"
  | "paused"
  | "stopped"
  | "repair"
  | "unapproved"
  | "apply"
  | "grant"
  | "unknown"
  | "connector"
  | "failing"
  | "expiring"
  | "repairPrepared"
  | "approved"
  | "manual";

export type StripAction =
  | { kind: "retry" }
  | { kind: "chat" }
  | { kind: "enable" }
  | { kind: "resume"; scheduleIds: string[] }
  | { kind: "approve"; via: "apply" | "grant" | "extend" }
  | { kind: "recheck" }
  | { kind: "connector"; connectorId: string }
  | { kind: "cause"; runId: string }
  | { kind: "review" };

type StripTone = "ok" | "info" | "warn" | "error";

type RenderedStripKind = Exclude<StripKind, "grant">;

interface WorkflowStrip {
  kind: StripKind;
  tone: StripTone;
  action: StripAction | null;
  lower: StripKind[];
}

export interface WaitingConnector {
  id: string | null;
  name: string;
  state: "expired" | "missing" | "deleted";
}

export interface StripInput {
  automation: AutomationState | null;
  failed: boolean;
  disabled: boolean;
  noSteps?: boolean;
  health: string | null;
  failedRunId: string | null;
  repairPrepared: boolean;
  waitingConnector: WaitingConnector | null;
  rights: { write: boolean; chat: boolean };
}

const TONES: Record<RenderedStripKind, StripTone> = {
  loading: "ok",
  failed: "error",
  invalid: "error",
  disabled: "warn",
  empty: "info",
  paused: "warn",
  stopped: "error",
  repair: "warn",
  unapproved: "info",
  apply: "warn",
  unknown: "warn",
  connector: "warn",
  failing: "error",
  expiring: "warn",
  repairPrepared: "info",
  approved: "ok",
  manual: "ok",
};

function hasAction(state: AutomationState, kind: AutomationAction["kind"]): boolean {
  return state.primaryAction?.kind === kind || state.secondaryAction?.kind === kind;
}

export function workflowStrip(input: StripInput): WorkflowStrip {
  const { automation, rights } = input;
  if (input.failed)
    return { kind: "failed", tone: TONES.failed, action: { kind: "retry" }, lower: [] };
  if (input.noSteps && !input.disabled)
    return { kind: "empty", tone: TONES.empty, action: null, lower: [] };
  if (!automation && !input.disabled)
    return { kind: "loading", tone: TONES.loading, action: null, lower: [] };

  const candidates: { kind: RenderedStripKind; action: StripAction | null }[] = [];
  const approvable = rights.write && automation?.target != null;
  if (automation?.state === "invalid")
    candidates.push({ kind: "invalid", action: rights.chat ? { kind: "chat" } : null });
  if (input.disabled)
    candidates.push({ kind: "disabled", action: rights.write ? { kind: "enable" } : null });
  if (input.waitingConnector?.state === "deleted")
    candidates.push({ kind: "connector", action: rights.chat ? { kind: "chat" } : null });

  switch (input.disabled ? null : automation!.state) {
    case "paused": {
      const resume = automation!.primaryAction;
      candidates.push({
        kind: "paused",
        action:
          resume?.kind === "resume" && rights.write
            ? { kind: "resume", scheduleIds: resume.scheduleIds }
            : null,
      });
      break;
    }
    case "repair":
      candidates.push({ kind: "repair", action: null });
      break;
    case "grant": {
      const once = automation!.history.length > 0;
      candidates.push({
        kind: once ? "stopped" : "unapproved",
        action: approvable ? { kind: "approve", via: "grant" } : null,
      });
      break;
    }
    case "manual":
      if (automation!.primaryAction?.kind === "grant" && !automation!.facts.inactive)
        candidates.push({
          kind: "unapproved",
          action: approvable ? { kind: "approve", via: "grant" } : null,
        });
      break;
    case "apply":
      candidates.push({
        kind: "apply",
        action: approvable ? { kind: "approve", via: "apply" } : null,
      });
      break;
    case "unknown":
      candidates.push({ kind: "unknown", action: { kind: "recheck" } });
      break;
  }
  if (input.waitingConnector && input.waitingConnector.state !== "deleted")
    candidates.push({
      kind: "connector",
      action: input.waitingConnector.id
        ? { kind: "connector", connectorId: input.waitingConnector.id }
        : null,
    });
  if (input.health && input.health !== "ok" && input.health !== "needs_reauth")
    candidates.push({
      kind: "failing",
      action: input.failedRunId ? { kind: "cause", runId: input.failedRunId } : null,
    });
  if (automation?.state === "approved" && hasAction(automation, "extend"))
    candidates.push({
      kind: "expiring",
      action: approvable ? { kind: "approve", via: "extend" } : null,
    });
  if (input.repairPrepared) candidates.push({ kind: "repairPrepared", action: { kind: "review" } });

  const [top, ...rest] = candidates;
  if (!top) {
    const calm = automation!.state === "approved" ? "approved" : "manual";
    return { kind: calm, tone: TONES[calm], action: null, lower: [] };
  }
  return {
    kind: top.kind,
    tone: TONES[top.kind],
    action: top.action,
    lower: rest.map((entry) => entry.kind),
  };
}

export function deletedConnectorReference(value: unknown): WaitingConnector | null {
  if (!Array.isArray(value)) return null;
  const reference = value.find(
    (item) =>
      item &&
      typeof item === "object" &&
      item.reason === "deleted" &&
      typeof item.name === "string" &&
      item.name.trim(),
  );
  return reference
    ? {
        id: typeof reference.connector_id === "string" ? reference.connector_id : null,
        name: reference.name,
        state: "deleted",
      }
    : null;
}
