import type { components } from "@cli-core/engine-api/openapi";
import { type ActorDirectory, actorDirectoryName } from "@/app/actor-directory-model";
import type { TranslationKey } from "@/lib/i18n";

export type WorkflowVersion = components["schemas"]["WorkflowVersion"] & {
  author?: { kind: "user" | "system_account"; id: string } | null;
  checksum?: string;
};

export function workflowVersionAuthor(
  author: WorkflowVersion["author"] | undefined,
  directory: ActorDirectory,
  t: (key: TranslationKey) => string,
): string {
  if (!author) return t("runs.caller.unknown");
  return (
    actorDirectoryName(directory, author.kind, author.id) ??
    t(author.kind === "user" ? "audit.actor.user" : "audit.actor.systemAccount")
  );
}

type WorkflowVersionState = "current" | "draft" | "invalid" | "superseded";

export interface WorkflowVersionIds {
  current: string | null;
  draft: string | null;
}

interface WorkflowVersionView {
  state: WorkflowVersionState;
  newest: boolean;
  invalid: boolean;
  restorable: boolean;
  newestVersion: number | null;
  nextVersion: number | null;
  pendingDraft: boolean;
  draftVersion: number | null;
}

export interface WorkflowVersionAccess {
  canRestore: boolean;
  archived: boolean;
}

interface WorkflowVersionSheetCopy {
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
  history: readonly WorkflowVersion[],
  ids: WorkflowVersionIds,
): WorkflowVersionView {
  const state = workflowVersionState(version, ids);
  const newest = history[0];
  const isNewest = newest !== undefined && newest.id === version.id;
  const pendingDraft = ids.draft !== null && ids.draft !== version.id && ids.draft !== ids.current;
  return {
    state,
    newest: isNewest,
    invalid: version.invalid,
    restorable: !isNewest && state === "superseded",
    newestVersion: newest?.version ?? null,
    nextVersion: newest ? newest.version + 1 : null,
    pendingDraft,
    draftVersion: pendingDraft
      ? (history.find((entry) => entry.id === ids.draft)?.version ?? null)
      : null,
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
  access: WorkflowVersionAccess,
): WorkflowVersionSheetCopy {
  const newest = label(view.newestVersion);
  const next = label(view.nextVersion);
  if (view.newest) return { restore: false, hint: "workflowVersions.newestHint", values: {} };
  if (view.state === "current")
    return { restore: false, hint: "workflowVersions.currentHint", values: { newest } };
  if (view.state === "draft")
    return { restore: false, hint: "workflowVersions.draftHint", values: {} };
  if (view.invalid) return { restore: false, hint: "workflowVersions.invalidHint", values: {} };
  if (access.archived) return { restore: false, hint: "workflowVersions.archivedHint", values: {} };
  if (!access.canRestore)
    return { restore: false, hint: "workflowVersions.restoreNotPermitted", values: {} };
  if (view.pendingDraft)
    return view.draftVersion === null
      ? {
          restore: view.restorable,
          hint: "workflowVersions.restoreHintOpenDraft",
          values: { next },
        }
      : {
          restore: view.restorable,
          hint: "workflowVersions.restoreHintDraft",
          values: { next, draft: label(view.draftVersion) },
        };
  return {
    restore: view.restorable,
    hint: "workflowVersions.restoreHint",
    values: { next, newest },
  };
}
