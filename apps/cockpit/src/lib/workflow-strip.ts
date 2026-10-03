import type { AutomationAction, AutomationState } from "@/lib/automation-state";
import type { TranslationKey } from "@/lib/i18n";

/**
 * What a workflow's status strip says, top state first (spec D15):
 * Gestoppt › Wartet auf Freigabe › Schlägt fehl › Freigabe läuft ab ›
 * Reparatur vorbereitet › ok. The automation decision
 * (`lib/automation-state.ts`) stays the one judge of whether the workflow may
 * run on its own; the strip only orders it against the run health and an open
 * repair, and gives the top state alone its action.
 */
export type StripKind =
  | "loading"
  | "failed"
  | "legacy"
  | "paused"
  | "apply"
  | "grant"
  | "repair"
  | "unknown"
  | "failing"
  | "expiring"
  | "repairPrepared"
  | "approved"
  | "manual";

export type StripAction =
  | { kind: "retry" }
  | { kind: "chat" }
  | { kind: "resume"; scheduleIds: string[] }
  /** Opens the approval dialog: a saved change, a first approval or an extension. */
  | { kind: "approve"; via: "apply" | "grant" | "extend" }
  | { kind: "recheck" }
  /** Opens the newest failed run's sheet. */
  | { kind: "cause"; runId: string }
  /** Opens the review sheet of the filed repair. */
  | { kind: "review" };

export type StripTone = "ok" | "warn" | "error";

export interface WorkflowStrip {
  kind: StripKind;
  tone: StripTone;
  action: StripAction | null;
  /** The lower states that also apply, for "+N weitere". */
  lower: StripKind[];
}

export interface StripInput {
  automation: AutomationState | null;
  /** The approvals could not be read. */
  failed: boolean;
  /** The engine's run health; anything but `ok` (or nothing) is failing. */
  health: string | null;
  /** The newest failed run, where one is on record and may be read. */
  failedRunId: string | null;
  /** A repair proposal waits for review. */
  repairPrepared: boolean;
  rights: { write: boolean; chat: boolean };
}

const TONES: Record<StripKind, StripTone> = {
  loading: "ok",
  failed: "error",
  legacy: "error",
  paused: "warn",
  apply: "warn",
  grant: "warn",
  repair: "error",
  unknown: "warn",
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
  paused: "workflowStrip.state.paused",
  apply: "workflowStrip.state.apply",
  grant: "workflowStrip.state.grant",
  repair: "automation.state.repair",
  unknown: "automation.state.unknown",
  failing: "workflowStrip.state.failing",
  expiring: "workflowStrip.state.expiring",
  repairPrepared: "workflowStrip.state.repairPrepared",
  approved: "automation.state.approved",
  manual: "automation.state.manual",
};

export function stripActionKey(action: StripAction): TranslationKey {
  switch (action.kind) {
    case "retry":
      return "pattern.retry";
    case "chat":
      return "remedy.chat";
    case "resume":
      return "automation.action.resume";
    case "approve":
      return action.via === "apply"
        ? "automation.action.apply"
        : action.via === "extend"
          ? "workflowStrip.action.extend"
          : "workflowStrip.action.grant";
    case "recheck":
      return "automation.action.recheck";
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
  if (!automation) return { kind: "loading", tone: "ok", action: null, lower: [] };

  const candidates: { kind: StripKind; action: StripAction | null }[] = [];
  const approvable = rights.write && automation.target !== null;
  switch (automation.state) {
    case "legacy":
      candidates.push({ kind: "legacy", action: rights.chat ? { kind: "chat" } : null });
      break;
    case "paused": {
      const resume = automation.primaryAction;
      candidates.push({
        kind: "paused",
        action:
          resume?.kind === "resume" && rights.write
            ? { kind: "resume", scheduleIds: resume.scheduleIds }
            : null,
      });
      break;
    }
    case "apply":
      candidates.push({
        kind: "apply",
        action: approvable ? { kind: "approve", via: "apply" } : null,
      });
      break;
    case "grant":
      candidates.push({
        kind: "grant",
        action: approvable ? { kind: "approve", via: "grant" } : null,
      });
      break;
    // The gate's own diagnosis carries the act per refused step, right below.
    case "repair":
      candidates.push({ kind: "repair", action: null });
      break;
    case "unknown":
      candidates.push({ kind: "unknown", action: { kind: "recheck" } });
      break;
    default:
      break;
  }
  if (input.health && input.health !== "ok")
    candidates.push({
      kind: "failing",
      action: input.failedRunId ? { kind: "cause", runId: input.failedRunId } : null,
    });
  if (automation.state === "approved" && hasAction(automation, "extend"))
    candidates.push({
      kind: "expiring",
      action: approvable ? { kind: "approve", via: "extend" } : null,
    });
  if (input.repairPrepared) candidates.push({ kind: "repairPrepared", action: { kind: "review" } });

  const [top, ...rest] = candidates;
  if (!top) {
    if (automation.state === "approved")
      return { kind: "approved", tone: "ok", action: null, lower: [] };
    // Nothing starts it on its own: calm, and the approval is still offered —
    // nothing asks for it.
    const offered = approvable && automation.primaryAction?.kind === "grant";
    return {
      kind: "manual",
      tone: "ok",
      action: offered ? { kind: "approve", via: "grant" } : null,
      lower: [],
    };
  }
  return {
    kind: top.kind,
    tone: TONES[top.kind],
    action: top.action,
    lower: rest.map((entry) => entry.kind),
  };
}
