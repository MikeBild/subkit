import type {
  ApprovalChoice,
  ApprovalRemedy,
  EnvironmentBlockCode,
} from "@shared/approval-choice.ts";
import { connectorHref } from "@/app/links";
import type { ReviewEnvironment } from "@/features/grants/model/review-environment";
import type { TranslationKey } from "@/lib/i18n";
import { type Remedy, remedyFor } from "@/lib/remedy";

export const BLOCK_SENTENCE_KEYS: Record<EnvironmentBlockCode, TranslationKey> = {
  connector_missing: "authority.decision.block.connector_missing",
  connector_without_sign_in: "authority.decision.block.connector_without_sign_in",
  connector_needs_sign_in_again: "authority.decision.block.connector_needs_sign_in_again",
  connector_switched_off: "authority.decision.block.connector_switched_off",
};

export function approvalRemedyLink(
  remedy: ApprovalRemedy | null,
): Pick<Remedy, "labelKey" | "href"> | null {
  if (!remedy?.connector_id) return null;
  if (remedy.kind === "sign_in_again") {
    const link = remedyFor({
      authState: { connectorId: remedy.connector_id, state: "expired", section: "credentials" },
      canRun: false,
      canChat: false,
    });
    return link ? { labelKey: link.labelKey, href: link.href } : null;
  }
  return { labelKey: "run.openConnector", href: connectorHref(remedy.connector_id) };
}

export function reviewedEnvironment(input: {
  choice: ApprovalChoice;
  asked: ReviewEnvironment;
  pinned: boolean;
  hint?: ReviewEnvironment;
}): ReviewEnvironment {
  if (input.choice.kind === "single") return input.choice.environment;
  if (input.pinned) return input.asked;
  if (input.choice.kind === "choice") return input.hint ?? input.choice.recommended;
  return input.asked;
}
