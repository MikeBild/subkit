export const WORKFLOW_LIFECYCLES = ["draft", "active", "archived"] as const;
export type WorkflowLifecycle = (typeof WORKFLOW_LIFECYCLES)[number];

export interface WorkflowState {
  lifecycle: WorkflowLifecycle;
  current_version_id: string | null;
  draft_version_id: string | null;
}

export type CreateWorkflow = { type: "CreateWorkflow"; version_id: string };
export type SaveDraft = { type: "SaveDraft"; version_id: string };
export type ActivateDraft = { type: "ActivateDraft"; version_id: string };
export type ArchiveWorkflow = { type: "ArchiveWorkflow" };
export type RestoreWorkflow = { type: "RestoreWorkflow" };
export type RotateVersion = { type: "RotateVersion"; version_id: string };
export type RestoreVersion = { type: "RestoreVersion"; version_id: string };

export type WorkflowCommand =
  | CreateWorkflow
  | SaveDraft
  | ActivateDraft
  | ArchiveWorkflow
  | RestoreWorkflow
  | RotateVersion
  | RestoreVersion;

type WorkflowCommandType = WorkflowCommand["type"];

export const WORKFLOW_COMMAND_TYPES = [
  "CreateWorkflow",
  "SaveDraft",
  "ActivateDraft",
  "ArchiveWorkflow",
  "RestoreWorkflow",
  "RotateVersion",
  "RestoreVersion",
] as const satisfies ReadonlyArray<WorkflowCommandType>;

export type WorkflowStatus = WorkflowLifecycle | "none";

export const WORKFLOW_TRANSITIONS: Readonly<
  Record<WorkflowStatus, ReadonlyArray<WorkflowCommandType>>
> = {
  none: ["CreateWorkflow", "SaveDraft"],
  draft: ["SaveDraft", "ActivateDraft", "ArchiveWorkflow", "RotateVersion", "RestoreVersion"],
  active: ["SaveDraft", "ActivateDraft", "ArchiveWorkflow", "RotateVersion", "RestoreVersion"],
  archived: ["SaveDraft", "RestoreWorkflow", "RotateVersion", "RestoreVersion"],
};

type WorkflowEvent =
  | {
      type: "WorkflowCreated";
      lifecycle: "active" | "draft";
      current_version_id: string | null;
      draft_version_id: string | null;
    }
  | { type: "DraftSaved"; draft_version_id: string }
  | { type: "DraftActivated"; current_version_id: string }
  | { type: "WorkflowArchived" }
  | { type: "WorkflowRestored" }
  | { type: "VersionRotated"; current_version_id: string }
  | { type: "VersionRestored"; current_version_id: string };

interface LifecycleRejection {
  code: "lifecycle_transition_not_allowed";
  from: WorkflowStatus;
  command: WorkflowCommandType;
}

export interface ActivateDraftFacts {
  manifestDigestMatches: boolean;
  expectedCurrentVersionId: string | null;
  previousVersionIsNewer: boolean;
}

export type ActivateDraftRejection =
  | LifecycleRejection
  | { code: "manifest_changed" }
  | { code: "draft_changed" }
  | { code: "current_version_changed" }
  | { code: "newer_version_active" };

export type RestoreWorkflowRejection = LifecycleRejection | { code: "no_current_version" };

export type WorkflowRejection = ActivateDraftRejection | RestoreWorkflowRejection;

export type Decision<R> = { ok: true; event: WorkflowEvent } | { ok: false; rejection: R };

export function statusOf(state: WorkflowState | null): WorkflowStatus {
  return state ? state.lifecycle : "none";
}

export function hatStatus(state: WorkflowState | null, command: WorkflowCommandType): boolean {
  return WORKFLOW_TRANSITIONS[statusOf(state)].includes(command);
}

function accept(event: WorkflowEvent): { ok: true; event: WorkflowEvent } {
  return { ok: true, event };
}

function reject<R>(rejection: R): { ok: false; rejection: R } {
  return { ok: false, rejection };
}

export function decide(
  state: WorkflowState | null,
  command: ActivateDraft,
  facts: ActivateDraftFacts,
): Decision<ActivateDraftRejection>;
export function decide(
  state: WorkflowState | null,
  command: RestoreWorkflow,
): Decision<RestoreWorkflowRejection>;
export function decide(
  state: WorkflowState | null,
  command: Exclude<WorkflowCommand, ActivateDraft | RestoreWorkflow>,
): Decision<LifecycleRejection>;
export function decide(
  state: WorkflowState | null,
  command: WorkflowCommand,
  facts?: ActivateDraftFacts,
): Decision<WorkflowRejection>;
export function decide(
  state: WorkflowState | null,
  command: WorkflowCommand,
  facts?: ActivateDraftFacts,
): Decision<WorkflowRejection> {
  if (!hatStatus(state, command.type))
    return reject({
      code: "lifecycle_transition_not_allowed",
      from: statusOf(state),
      command: command.type,
    });
  if (!state)
    return accept(
      command.type === "CreateWorkflow"
        ? {
            type: "WorkflowCreated",
            lifecycle: "active",
            current_version_id: command.version_id,
            draft_version_id: null,
          }
        : {
            type: "WorkflowCreated",
            lifecycle: "draft",
            current_version_id: null,
            draft_version_id: (command as SaveDraft).version_id,
          },
    );
  switch (command.type) {
    case "SaveDraft":
      return accept({ type: "DraftSaved", draft_version_id: command.version_id });
    case "ActivateDraft": {
      if (state.draft_version_id !== command.version_id) return reject({ code: "draft_changed" });
      if (state.current_version_id !== (facts?.expectedCurrentVersionId ?? null))
        return reject({ code: "current_version_changed" });
      if (!facts?.manifestDigestMatches) return reject({ code: "manifest_changed" });
      if (facts.previousVersionIsNewer) return reject({ code: "newer_version_active" });
      return accept({ type: "DraftActivated", current_version_id: command.version_id });
    }
    case "ArchiveWorkflow":
      return accept({ type: "WorkflowArchived" });
    case "RestoreWorkflow":
      if (state.current_version_id === null) return reject({ code: "no_current_version" });
      return accept({ type: "WorkflowRestored" });
    case "RotateVersion":
      return accept({ type: "VersionRotated", current_version_id: command.version_id });
    default:
      return accept({ type: "VersionRestored", current_version_id: command.version_id });
  }
}

export function evolve(state: WorkflowState | null, event: WorkflowEvent): WorkflowState {
  if (event.type === "WorkflowCreated")
    return {
      lifecycle: event.lifecycle,
      current_version_id: event.current_version_id,
      draft_version_id: event.draft_version_id,
    };
  const base: WorkflowState = state ?? {
    lifecycle: "draft",
    current_version_id: null,
    draft_version_id: null,
  };
  switch (event.type) {
    case "DraftSaved":
      return { ...base, draft_version_id: event.draft_version_id };
    case "DraftActivated":
      return {
        lifecycle: "active",
        current_version_id: event.current_version_id,
        draft_version_id: null,
      };
    case "WorkflowArchived":
      return { ...base, lifecycle: "archived" };
    case "WorkflowRestored":
      return { ...base, lifecycle: "active" };
    default:
      return { ...base, current_version_id: event.current_version_id };
  }
}

export function nextVersion(versions: ReadonlyArray<number>): number {
  let highest = 0;
  for (const version of versions) if (version > highest) highest = version;
  return highest + 1;
}

export function describeRejection(rejection: WorkflowRejection): string {
  switch (rejection.code) {
    case "lifecycle_transition_not_allowed":
      if (rejection.from === "draft" && rejection.command === "RestoreWorkflow")
        return "a draft workflow becomes active only through review and activation";
      if (rejection.from === "archived" && rejection.command === "ActivateDraft")
        return "this workflow is archived; restore it before activating a reviewed change";
      return `a workflow in lifecycle "${rejection.from}" does not accept ${rejection.command}`;
    case "no_current_version":
      return "this workflow has no reviewed version to restore; review and activate a version first";
    case "manifest_changed":
      return "the reviewed boundary changed; review again";
    case "newer_version_active":
      return "A newer version became active after this change was saved; reload and save it again.";
    default:
      return "The workflow changed; review the latest saved change again.";
  }
}
