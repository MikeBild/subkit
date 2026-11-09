import type { PatchCandidate } from "@/api/decisions";
import type { TranslationKey } from "@/lib/i18n";
import { computeLineDiff, type FocusedRow, focusDiff, toDiffLines } from "@/lib/line-diff";
import type { DecidableKind, DecisionItem } from "@/pages/decisions-model";

export type PatchChangeKind = {
  proposalKind: string | null;
  driftKind: string | null;
  fixer: string | null;
};
export type PatchTitle = { key: TranslationKey; params: Record<string, string> };
export type ChangeFactDescriptor = {
  path: string;
  inline: { before: string; after: string } | null;
  rows: FocusedRow[];
};

const CHANGE_FACT_LIMIT = 3;
const CHANGE_VALUE_LIMIT = 120;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function patchChangeKind(candidate: PatchCandidate): PatchChangeKind {
  const envelope = object(candidate.diff),
    proposal = object(envelope.proposal),
    signal = object(envelope.drift_signal);
  return {
    proposalKind: text(proposal.kind),
    driftKind: text(signal.kind),
    fixer: text(signal.fixer),
  };
}

export function patchTitle(input: { workflow: string | null; change: string | null }): PatchTitle {
  const workflow = input.workflow?.trim() || null,
    change = input.change?.trim() || null;
  if (workflow && change) return { key: "decisions.patchTitle", params: { workflow, change } };
  if (workflow) return { key: "decisions.patchTitleWorkflow", params: { workflow } };
  if (change) return { key: "decisions.patchTitleChange", params: { change } };
  return { key: "decisions.fallbackTitle.patch", params: {} };
}

export function approveBlockedReason(input: {
  canDecide: boolean;
  expanded: boolean;
  kind: DecidableKind;
  reviewDigest: string | null | undefined;
  preview: { reviewable?: boolean | null; review_digest?: string | null } | undefined;
}): TranslationKey | null {
  if (!input.canDecide) return "decisions.approveNeedsRole";
  if (!input.expanded) return "decisions.approveNeedsReview";
  if (input.kind === "skill") return input.reviewDigest ? null : "decisions.approveNotReviewable";
  return !input.preview || (input.preview.reviewable && input.preview.review_digest)
    ? null
    : "decisions.approveNotReviewable";
}

export function suggestionTargets(
  items: readonly DecisionItem[],
): Array<{ item: DecisionItem; workflowId: string }> {
  return items.flatMap((item) => {
    if (item.kind === "conversation" || item.reviewable !== false) return [];
    const detail = item.detail;
    const workflowId =
      detail.kind === "patch" || detail.kind === "skill" ? detail.evidence.workflowId : null;
    return workflowId ? [{ item, workflowId }] : [];
  });
}

export function humanStep(stepKey: string): string {
  return stepKey.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}
function valueAt(source: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      source,
    );
}
function shownValue(value: unknown): string {
  return value === undefined ? "—" : typeof value === "string" ? value : JSON.stringify(value);
}
function rows(before: unknown, after: unknown): FocusedRow[] {
  return focusDiff(computeLineDiff(toDiffLines(before), toDiffLines(after)));
}
function fact(path: string, before: unknown, after: unknown): ChangeFactDescriptor {
  const left = shownValue(before),
    right = shownValue(after);
  return !left.includes("\n") &&
    !right.includes("\n") &&
    left.length <= CHANGE_VALUE_LIMIT &&
    right.length <= CHANGE_VALUE_LIMIT
    ? { path, inline: { before: left, after: right }, rows: [] }
    : { path, inline: null, rows: rows(before, after) };
}
export function changeFacts(
  before: unknown,
  after: unknown,
  paths: readonly string[] | null | undefined,
): ChangeFactDescriptor[] {
  const listed = (paths ?? []).slice(0, CHANGE_FACT_LIMIT);
  if (listed.length === 0) {
    const focused = rows(before, after);
    return focused.length ? [{ path: "", inline: null, rows: focused }] : [];
  }
  return listed.map((path) => fact(path, valueAt(before, path), valueAt(after, path)));
}
export function changeRows(facts: readonly ChangeFactDescriptor[]): FocusedRow[] {
  return facts.flatMap((item) =>
    item.inline
      ? [
          { type: "removed" as const, text: item.inline.before },
          { type: "added" as const, text: item.inline.after },
        ]
      : item.rows,
  );
}
