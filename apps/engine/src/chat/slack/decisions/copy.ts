import type { SlackDecisionCopy, SlackDecisionLocale } from "../../../http/index.ts";

export async function slackDecisionText(locale: SlackDecisionLocale): Promise<SlackDecisionCopy> {
  const { slackDecisionCopy } = await import("../../../http/index.ts");
  return slackDecisionCopy(locale);
}
