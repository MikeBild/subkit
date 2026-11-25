import { OAUTH_AUTHORIZATION_URL_FIELD } from "@shared/elicitation-constants.ts";
import { type OpenQuestion, questionClass } from "@shared/typed-reply.ts";
import { APPROVAL_HANDLE_KEY } from "./tools/ask-user/commit-intent.ts";

const SAVE_WORKFLOW_DRAFT = "save_workflow_draft";

export const REUSABLE_APPROVAL_TOOLS: ReadonlySet<string> = new Set([SAVE_WORKFLOW_DRAFT]);

const CONFIRM_TOOL = "ask_user_confirm";

const SAVE_ARG_KEYS = new Set([
  "target_workflow_id",
  "force_commit",
  "expected_draft_version_id",
  "confirmed",
]);

const SAVE_INTENT_KEYS = new Set(["target_workflow_id", "force_commit", APPROVAL_HANDLE_KEY]);

export interface OpenApprovalCard extends OpenQuestion {
  readonly expires_at: Date;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
};

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JSON.parse(JSON.stringify(left ?? null))) ===
  canonicalJson(JSON.parse(JSON.stringify(right ?? null)));

const onlyKeys = (fields: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(fields).every((key) => allowed.has(key));

export function approvalHandleOf(input: unknown): string | null {
  const handle = record(record(record(input)?.commit_intent)?.payload)?.[APPROVAL_HANDLE_KEY];
  return typeof handle === "string" ? handle : null;
}

interface SaveApproval {
  readonly target_workflow_id: string | null;
  readonly force_commit: boolean;
  readonly expected_draft_version_id: string | null;
  readonly confirmed: boolean;
  readonly verification: unknown;
  readonly effect: unknown;
}

const optionalString = (value: unknown): string | null | undefined =>
  value === undefined || value === null ? null : typeof value === "string" ? value : undefined;

const optionalFlag = (value: unknown): boolean | undefined =>
  value === undefined ? false : typeof value === "boolean" ? value : undefined;

function saveApprovalOf(input: unknown): SaveApproval | null {
  const fields = record(input);
  if (!fields || fields.kind !== SAVE_WORKFLOW_DRAFT) return null;
  if (fields[OAUTH_AUTHORIZATION_URL_FIELD] != null) return null;
  const intent = record(fields.commit_intent);
  const payload = record(intent?.payload);
  if (intent?.kind !== SAVE_WORKFLOW_DRAFT || !payload || !onlyKeys(payload, SAVE_INTENT_KEYS))
    return null;
  const verification = record(fields.verification);
  if (typeof verification?.draft_fingerprint !== "string") return null;
  const target = record(fields.target);
  const args = target ? record(target.args) : {};
  if (target && target.tool !== SAVE_WORKFLOW_DRAFT) return null;
  if (!args || !onlyKeys(args, SAVE_ARG_KEYS)) return null;
  const targetWorkflowId = optionalString(args.target_workflow_id);
  const forceCommit = optionalFlag(args.force_commit);
  const expectedVersion = optionalString(args.expected_draft_version_id);
  const confirmed = optionalFlag(args.confirmed);
  const intentTarget = optionalString(payload.target_workflow_id);
  const intentForce = optionalFlag(payload.force_commit);
  if (
    targetWorkflowId === undefined ||
    forceCommit === undefined ||
    expectedVersion === undefined ||
    confirmed === undefined ||
    intentTarget === undefined ||
    intentForce === undefined
  )
    return null;
  if (target && (intentTarget !== targetWorkflowId || intentForce !== forceCommit)) return null;
  return {
    target_workflow_id: target ? targetWorkflowId : intentTarget,
    force_commit: target ? forceCommit : intentForce,
    expected_draft_version_id: expectedVersion,
    confirmed,
    verification,
    effect: fields.effect ?? null,
  };
}

export function asksForSameApproval(
  open: OpenApprovalCard,
  next: OpenQuestion,
  now: Date,
): boolean {
  if (open.tool_name !== CONFIRM_TOOL || next.tool_name !== CONFIRM_TOOL) return false;
  if (open.expires_at.getTime() <= now.getTime()) return false;
  if (questionClass(open) !== "button_only" || questionClass(next) !== "button_only") return false;
  if (record(record(next.input)?.target)?.tool !== SAVE_WORKFLOW_DRAFT) return false;
  const openApproval = saveApprovalOf(open.input);
  const nextApproval = saveApprovalOf(next.input);
  return openApproval !== null && nextApproval !== null && sameJson(openApproval, nextApproval);
}
