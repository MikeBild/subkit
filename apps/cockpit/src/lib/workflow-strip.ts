import type { AutomationAction, AutomationState } from "@/lib/automation-state";
import type { TranslationKey } from "@/lib/i18n";

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

export type StripTone = "ok" | "info" | "warn" | "error";

export interface WorkflowStrip {
  kind: StripKind;
  tone: StripTone;
  action: StripAction | null;
  lower: StripKind[];
}

export interface WaitingConnector {
  id: string;
  name: string;
  state: "expired" | "missing";
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

const TONES: Record<StripKind, StripTone> = {
  loading: "ok",
  failed: "error",
  invalid: "error",
  disabled: "warn",
  empty: "info",
  paused: "warn",
  stopped: "error",
  repair: "warn",
  unapproved: "warn",
  apply: "warn",
  grant: "warn",
  unknown: "warn",
  connector: "warn",
  failing: "error",
  expiring: "warn",
  repairPrepared: "warn",
  approved: "ok",
  manual: "ok",
};

export const STRIP_STATE_KEYS: Record<StripKind, TranslationKey> = {
  loading: "workflowStrip.state.loading",
  failed: "workflowStrip.state.failed",
  invalid: "automation.state.invalid",
  disabled: "workflowStrip.state.disabled",
  empty: "workflowStrip.state.empty",
  paused: "workflowStrip.state.paused",
  stopped: "workflowStrip.state.stopped",
  repair: "automation.state.repair",
  unapproved: "workflowStrip.state.unapproved",
  apply: "workflowStrip.state.grant",
  grant: "workflowStrip.state.grant",
  unknown: "automation.state.unknown",
  connector: "workflowStrip.state.connector",
  failing: "workflowStrip.state.failing",
  expiring: "workflowStrip.state.expiring",
  repairPrepared: "workflowStrip.state.repairPrepared",
  approved: "workflowStrip.state.running",
  manual: "workflowStrip.state.running",
};

export function stripActionKey(action: StripAction): TranslationKey {
  switch (action.kind) {
    case "retry":
      return "pattern.retry";
    case "chat":
      return "remedy.chat";
    case "enable":
      return "workflowStrip.action.enable";
    case "resume":
      return "automation.action.resume";
    case "approve":
      return action.via === "extend" ? "workflowStrip.action.extend" : "workflowStrip.action.grant";
    case "recheck":
      return "automation.action.recheck";
    case "connector":
      return "workflowStrip.action.connector";
    case "cause":
      return "workflowStrip.action.cause";
    case "review":
      return "remedy.reviewRepair";
  }
}

function hasAction(state: AutomationState, kind: AutomationAction["kind"]): boolean {
  return state.primaryAction?.kind === kind || state.secondaryAction?.kind === kind;
}

export function workflowStrip(input: StripInput): WorkflowStrip {
  const { automation, rights } = input;
  if (input.failed) return { kind: "failed", tone: "error", action: { kind: "retry" }, lower: [] };
  if (input.noSteps && !input.disabled)
    return { kind: "empty", tone: "info", action: null, lower: [] };
  if (!automation && !input.disabled)
    return { kind: "loading", tone: "ok", action: null, lower: [] };

  const candidates: { kind: StripKind; action: StripAction | null }[] = [];
  const approvable = rights.write && automation?.target != null;
  if (automation?.state === "invalid")
    candidates.push({ kind: "invalid", action: rights.chat ? { kind: "chat" } : null });
  if (input.disabled)
    candidates.push({ kind: "disabled", action: rights.write ? { kind: "enable" } : null });
  switch (input.disabled ? null : automation?.state) {
    case "paused": {
      const resume = automation?.primaryAction;
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
      const once = (automation?.history.length ?? 0) > 0;
      candidates.push({
        kind: once ? "stopped" : "grant",
        action: approvable ? { kind: "approve", via: "grant" } : null,
      });
      break;
    }
    case "manual":
      if (automation?.primaryAction?.kind === "grant" && !automation.facts.inactive)
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
    default:
      break;
  }
  if (input.waitingConnector)
    candidates.push({
      kind: "connector",
      action: { kind: "connector", connectorId: input.waitingConnector.id },
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
    const calm = automation?.state === "approved" ? "approved" : "manual";
    return { kind: calm, tone: "ok", action: null, lower: [] };
  }
  return {
    kind: top.kind,
    tone: TONES[top.kind],
    action: top.action,
    lower: rest.map((entry) => entry.kind),
  };
}
