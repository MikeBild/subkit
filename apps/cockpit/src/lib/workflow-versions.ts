import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

export type WorkflowVersion = components["schemas"]["WorkflowVersion"];

export type WorkflowVersionState = "current" | "draft" | "invalid" | "superseded";

export interface WorkflowVersionIds {
  current: string | null;
  draft: string | null;
}

export interface WorkflowVersionView {
  state: WorkflowVersionState;
  newest: boolean;
  invalid: boolean;
  restorable: boolean;
  newestVersion: number | null;
  nextVersion: number | null;
}

export interface WorkflowVersionSheetCopy {
  restore: boolean;
  hint: TranslationKey;
  values: Record<string, string>;
}

export const VERSION_STATE_KEYS = {
  current: "workflowVersions.state.current",
  draft: "workflowVersions.state.draft",
  invalid: "workflowVersions.state.invalid",
  superseded: "workflowVersions.state.superseded",
} as const satisfies Record<WorkflowVersionState, TranslationKey>;

export const VERSION_BADGE_STATES = {
  current: "active",
  draft: "draft",
  invalid: "invalid",
  superseded: "superseded",
} as const satisfies Record<WorkflowVersionState, string>;

export function workflowVersionState(
  version: WorkflowVersion,
  ids: WorkflowVersionIds,
): WorkflowVersionState {
  if (version.id === ids.current) return "current";
  if (version.id === ids.draft) return "draft";
  if (version.invalid) return "invalid";
  return "superseded";
}

export function workflowVersionView(
  version: WorkflowVersion,
  newest: WorkflowVersion | undefined,
  ids: WorkflowVersionIds,
): WorkflowVersionView {
  const state = workflowVersionState(version, ids);
  const isNewest = newest !== undefined && newest.id === version.id;
  return {
    state,
    newest: isNewest,
    invalid: version.invalid,
    restorable: !isNewest && state !== "current" && !version.invalid,
    newestVersion: newest?.version ?? null,
    nextVersion: newest ? newest.version + 1 : null,
  };
}

const RESTORED_FROM = /^restored from v(\d+)$/;

export function restoredFrom(note: string | null): number | null {
  const match = note?.trim().match(RESTORED_FROM);
  return match ? Number(match[1]) : null;
}

const label = (version: number | null) => (version === null ? "" : `v${version}`);

export function workflowVersionSheetCopy(
  view: WorkflowVersionView,
  canRestore: boolean,
): WorkflowVersionSheetCopy {
  const newest = label(view.newestVersion);
  if (view.newest) return { restore: false, hint: "workflowVersions.newestHint", values: {} };
  if (view.state === "current")
    return { restore: false, hint: "workflowVersions.currentHint", values: { newest } };
  if (view.invalid) return { restore: false, hint: "workflowVersions.invalidHint", values: {} };
  if (!canRestore)
    return { restore: false, hint: "workflowVersions.restoreNotPermitted", values: {} };
  return {
    restore: view.restorable,
    hint: "workflowVersions.restoreHint",
    values: { next: label(view.nextVersion), newest },
  };
}
