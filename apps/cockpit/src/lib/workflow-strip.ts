import type { AutomationAction, AutomationState } from "@/lib/automation-state";
import type { TranslationKey } from "@/lib/i18n";

/**
 * What a workflow's status strip says, top state first (D15, as reviewed):
 * Deaktiviert › Gestoppt › Reparatur nötig › Nicht freigegeben › Wartet auf
 * Freigabe › Wartet auf Konnektor › Schlägt fehl › Freigabe läuft ab ›
 * Reparatur vorbereitet › Läuft. The automation decision
 * (`lib/automation-state.ts`) stays the one judge of whether the workflow may
 * run on its own; the strip orders it against the workflow's switch, the
 * sign-ins of its connectors, its run health and an open repair, and gives
 * the top state alone its action.
 */
export type StripKind =
  | "loading"
  | "failed"
  | "legacy"
  | "disabled"
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
  /** Opens the approval dialog: a saved change, a first approval or an extension. */
  | { kind: "approve"; via: "apply" | "grant" | "extend" }
  | { kind: "recheck" }
  /** Opens the connector whose sign-in the workflow waits for. */
  | { kind: "connector"; connectorId: string }
  /** Opens the newest failed run's sheet. */
  | { kind: "cause"; runId: string }
  /** Opens the review sheet of the filed repair. */
  | { kind: "review" };

export type StripTone = "ok" | "warn" | "error";

export interface WorkflowStrip {
  kind: StripKind;
  tone: StripTone;
  action: StripAction | null;
  /** The lower states that also apply, for "+N weiteres". */
  lower: StripKind[];
}

/** A connector the workflow uses whose sign-in is gone. */
export interface WaitingConnector {
  id: string;
  name: string;
  state: "expired" | "missing";
}

export interface StripInput {
  automation: AutomationState | null;
  /** The approvals could not be read. */
  failed: boolean;
  /** The workflow is switched off (`lifecycle: archived`). */
  disabled: boolean;
  /** The engine's run health; anything but `ok` (or nothing) is failing. */
  health: string | null;
  /** The newest failed run, where one is on record and may be read. */
  failedRunId: string | null;
  /** A repair proposal waits for review. */
  repairPrepared: boolean;
  /** The first connector the workflow uses that cannot sign in. */
  waitingConnector: WaitingConnector | null;
  rights: { write: boolean; chat: boolean };
}

const TONES: Record<StripKind, StripTone> = {
  loading: "ok",
  failed: "error",
  legacy: "error",
  disabled: "warn",
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
  legacy: "automation.state.legacy",
  disabled: "workflowStrip.state.disabled",
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

/** The strip of one workflow: its top state, that state's one action, and the rest. */
export function workflowStrip(input: StripInput): WorkflowStrip {
  const { automation, rights } = input;
  if (input.failed) return { kind: "failed", tone: "error", action: { kind: "retry" }, lower: [] };
  if (!automation && !input.disabled)
    return { kind: "loading", tone: "ok", action: null, lower: [] };

  const candidates: { kind: StripKind; action: StripAction | null }[] = [];
  const approvable = rights.write && automation?.target != null;
  if (automation?.state === "legacy")
    candidates.push({ kind: "legacy", action: rights.chat ? { kind: "chat" } : null });
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
    // The gate refuses steps: the diagnosis below the strip carries one act
    // per step, so the strip carries none.
    case "repair":
      candidates.push({ kind: "repair", action: null });
      break;
    case "grant": {
      // Something starts it and no approval covers it. Once approved before,
      // it has stopped; never approved, it waits for its first approval.
      const once = (automation?.history.length ?? 0) > 0;
      candidates.push({
        kind: once ? "stopped" : "grant",
        action: approvable ? { kind: "approve", via: "grant" } : null,
      });
      break;
    }
    case "manual":
      // Nothing starts it on its own and nothing approved it: only trial runs.
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
