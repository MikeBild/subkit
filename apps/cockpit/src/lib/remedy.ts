import { attentionHref, chatNewHref, connectorHref, workflowAutomationHref } from "@/app/links";
import type { TranslationKey } from "@/lib/i18n";

export type RemedyKind =
  | "review_repair"
  | "grant"
  | "sign_in"
  | "reconnect"
  | "check_auth"
  | "retry"
  | "chat"
  | "admin";

export const REMEDY_LABEL = {
  review_repair: "remedy.reviewRepair",
  grant: "remedy.grant",
  sign_in: "remedy.reauth",
  reconnect: "remedy.reconnect",
  check_auth: "remedy.checkAuth",
  retry: "remedy.retry",
  chat: "remedy.chat",
  admin: "remedy.admin",
} as const satisfies Record<RemedyKind, TranslationKey>;

export interface Remedy {
  kind: RemedyKind;
  labelKey: TranslationKey;
  href: string;
}

export interface RemedyInput {
  workflowId?: string | null;
  executionId?: string | null;
  patch?: { id: string } | null;
  authState?: {
    connectorId: string;
    state: "expired" | "credentials_missing" | string;
    section?: "credentials";
  } | null;
  held?: boolean;
  canRun: boolean;
  canChat: boolean;
  prompt?: string | null;
}

export function remedyFor(input: RemedyInput): Remedy | null {
  if (input.patch) {
    return {
      kind: "review_repair",
      labelKey: REMEDY_LABEL.review_repair,
      href: input.workflowId
        ? attentionHref({ review: `workflow:${input.workflowId}` })
        : attentionHref(),
    };
  }
  if (input.held && input.workflowId) {
    return {
      kind: "grant",
      labelKey: REMEDY_LABEL.grant,
      href: workflowAutomationHref(input.workflowId),
    };
  }
  if (input.authState) {
    const expired =
      input.authState.state === "expired" || input.authState.state === "credentials_missing";
    const card = input.authState.section === "credentials";
    return {
      kind: expired ? "reconnect" : "check_auth",
      labelKey: expired
        ? card
          ? REMEDY_LABEL.reconnect
          : "remedy.reauth"
        : REMEDY_LABEL.check_auth,
      href: `${connectorHref(input.authState.connectorId)}${card ? "#connector-credentials" : ""}`,
    };
  }
  if (input.canChat) {
    return {
      kind: "chat",
      labelKey: REMEDY_LABEL.chat,
      href: chatNewHref({
        prompt: input.prompt ?? null,
        workflowId: input.workflowId ?? null,
        executionId: input.executionId ?? null,
        references: [
          ...(input.workflowId ? [{ type: "workflow" as const, id: input.workflowId }] : []),
          ...(input.executionId ? [{ type: "execution" as const, id: input.executionId }] : []),
        ],
      }),
    };
  }
  return null;
}
