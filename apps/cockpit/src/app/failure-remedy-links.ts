import type { FailureFacts, FailureRemedyKind } from "@/lib/failure-remedy";
import {
  absolute,
  attentionHref,
  chatNewHref,
  connectorHref,
  connectorsHref,
  peopleHref,
  workflowAutomationHref,
} from "./links";
import { loginHref } from "./login-href";

export function failureRemedyHref(
  kind: Exclude<FailureRemedyKind, "retry">,
  facts: FailureFacts,
  prompt: string,
): string {
  switch (kind) {
    case "sign_in":
      return loginHref();
    case "reconnect":
      return absolute(
        facts.connectorId
          ? `${connectorHref(facts.connectorId)}#connector-credentials`
          : connectorsHref({ health: "not_ok" }),
      );
    case "grant":
      return absolute(
        facts.workflowId ? workflowAutomationHref(facts.workflowId) : attentionHref(),
      );
    case "chat":
      return absolute(
        chatNewHref({ prompt, workflowId: facts.workflowId, connectorId: facts.connectorId }),
      );
    case "admin":
      return absolute(peopleHref());
    case "new_conversation":
      return absolute(chatNewHref());
  }
}
