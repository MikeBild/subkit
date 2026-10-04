import { attentionHref, chatNewHref, connectorHref, workflowAutomationHref } from "@/app/links";
import type { TranslationKey } from "@/lib/i18n";

export interface Remedy {
  kind: "review_repair" | "grant" | "reauth" | "check_auth" | "chat";
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
      labelKey: "remedy.reviewRepair",
      href: input.workflowId
        ? attentionHref({ review: `workflow:${input.workflowId}` })
        : attentionHref(),
    };
  }
  if (input.held && input.workflowId) {
    return {
      kind: "grant",
      labelKey: "remedy.grant",
      href: workflowAutomationHref(input.workflowId),
    };
  }
  if (input.authState) {
    const expired =
      input.authState.state === "expired" || input.authState.state === "credentials_missing";
    const card = input.authState.section === "credentials";
    return {
      kind: expired ? "reauth" : "check_auth",
      labelKey: expired ? (card ? "remedy.reconnect" : "remedy.reauth") : "remedy.checkAuth",
      href: `${connectorHref(input.authState.connectorId)}${card ? "?tab=verbindung" : ""}`,
    };
  }
  if (input.canChat) {
    return {
      kind: "chat",
      labelKey: "remedy.chat",
      href: chatNewHref({
        prompt: input.prompt ?? null,
        workflowId: input.workflowId ?? null,
        executionId: input.executionId ?? null,
      }),
    };
  }
  return null;
}
