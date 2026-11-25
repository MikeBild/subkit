import { isDeepStrictEqual } from "node:util";
import { LOCAL_CONFIRMATION_KIND } from "@shared/device/confirmation.ts";
import { OAUTH_AUTHORIZATION_URL_FIELD } from "@shared/elicitation-constants.ts";
import { type OpenQuestion, questionClass } from "@shared/typed-reply.ts";
import { APPROVAL_HANDLE_KEY } from "./tools/ask-user/commit-intent.ts";

interface ApprovalAction {
  readonly name: string;
  readonly targetArgs?: unknown;
  readonly intent?: { readonly kind: unknown; readonly payload: Record<string, unknown> };
}

const BROAD_KINDS = new Set(["generic", "external_write"]);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const withoutHandle = (payload: unknown): Record<string, unknown> => {
  const { [APPROVAL_HANDLE_KEY]: _handle, ...rest } = record(payload) ?? {};
  return rest;
};

const actionName = (
  fields: Record<string, unknown>,
  target: Record<string, unknown> | null,
  intent: Record<string, unknown> | null,
): string | null => {
  const intentTool = record(intent?.payload)?.tool;
  if (typeof target?.tool === "string") return target.tool;
  if (typeof intentTool === "string") return intentTool;
  if (typeof intent?.kind === "string") return intent.kind;
  if (typeof fields.kind === "string" && !BROAD_KINDS.has(fields.kind)) return fields.kind;
  return null;
};

export function approvalAction(input: unknown): ApprovalAction | null {
  const fields = record(input);
  if (!fields) return null;
  const target = record(fields.target);
  const intent = record(fields.commit_intent);
  const name = actionName(fields, target, intent);
  if (!name) return null;
  return {
    name,
    ...(target ? { targetArgs: target.args ?? {} } : {}),
    ...(intent
      ? {
          intent: {
            kind: intent.kind,
            payload:
              intent.kind === "commit_held_workflow_writes"
                ? (record(intent.payload) ?? {})
                : withoutHandle(intent.payload),
          },
        }
      : {}),
  };
}

const opensLink = (input: unknown): boolean =>
  record(input)?.[OAUTH_AUTHORIZATION_URL_FIELD] != null;

const agrees = (left: unknown, right: unknown): boolean =>
  left === undefined || right === undefined || isDeepStrictEqual(left, right);

export function asksForSameApproval(open: OpenQuestion, next: OpenQuestion): boolean {
  if (
    record(open.input)?.kind === LOCAL_CONFIRMATION_KIND ||
    record(next.input)?.kind === LOCAL_CONFIRMATION_KIND
  )
    return false;
  if (opensLink(open.input) || opensLink(next.input)) return false;
  if (questionClass(open) !== "button_only" || questionClass(next) !== "button_only") return false;
  const openAction = approvalAction(open.input);
  const nextAction = approvalAction(next.input);
  if (!openAction || !nextAction || openAction.name !== nextAction.name) return false;
  return (
    agrees(openAction.targetArgs, nextAction.targetArgs) &&
    agrees(openAction.intent, nextAction.intent)
  );
}
