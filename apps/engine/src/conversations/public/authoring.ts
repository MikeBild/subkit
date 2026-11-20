export { isExpectedCancellation } from "../abort.ts";
export { generateMainAgentSystemPrompt } from "../agent/context.ts";
export {
  humanChatAnswer,
  humanInBandAnswer,
  humanPortalAnswer,
  MODEL_RELAYED_ANSWER,
} from "../answer-actor.ts";
export { completeApprovalBackedElicitation } from "../approval-completion.ts";
export { harvestCitationsFromPersisted } from "../citations.ts";
export { getTaskRunCheck, getTaskRunMarker, withoutTaskRunCheck } from "../core/draft.ts";
export { loadDraft, loadFocusExecution } from "../draft.ts";
export { surfaceFromClientHeader } from "../lifecycle-view.ts";
export { continueConversationDevLiveTest } from "../live-test-continuation.ts";
export { messageHasText } from "../parts.ts";
export { readPlaybook, updatePlaybook } from "../playbook.ts";
export {
  type PlaybookPlan,
  PlaybookPlanSchema,
  type PlaybookView,
  PlaybookViewSchema,
} from "../playbook-contract.ts";
export type { PlaybookScope } from "../playbook-evidence.ts";
export { ResumeFormFieldSchema } from "../resume-form.ts";
export {
  type AppendMessageParams,
  type AppendMessageResult,
  appendUserMessage,
} from "../service/append.ts";
export {
  type CreateConversationParams,
  type CreateConversationResult,
  createConversation,
} from "../service/create.ts";
export { type RunConversationTurnParams, runConversationTurn } from "../service/run-turn.ts";
export type { ConversationTurnOutcome } from "../service/shared.ts";
export { clearTaskRunCheck } from "../service/task-run-check.ts";
export {
  readConversationPlaybookPlan,
  setConversationLoadedSkills,
} from "../service/tool-state.ts";
export { keepResolvableCitations } from "../source-faithful.ts";
export { serializeEvent } from "../streaming.ts";
export { messageOrigin, TASK_RUN_CONTINUATION_ORIGIN } from "../task-run-continuation.ts";
export { importConnectorFromSpecInputSchema } from "../tools/import-connector-from-spec-contract.ts";
export const importConnectorDraftFromSpec = async (params: unknown) => {
  const tool = await import("../tools/import-connector-from-spec.ts");
  return tool.importConnectorDraftFromSpec(params as never);
};
export const importConnectorFromSpecTool = {
  name: "import_connector_from_spec",
  description:
    "Import an API specification (an API request collection, HAR, OpenAPI or Google Discovery inline/URL up to 50 MiB, GraphQL SDL, GraphQL introspection endpoint, or a curl command) into a connector draft. Specification metadata seeds the base URL and authentication. Auto-matches a built-in template when the base URL is recognised; otherwise produces a manual HTTP connector draft with sampled endpoints attached.",
  use_case:
    "Use when the operator brings an existing API spec, request collection, curl command, or a GraphQL endpoint URL. Faster than manually describing the connector.",
  inputSchema: importConnectorFromSpecInputSchema,
  category: "tenant_write",
  async execute(ctx: unknown, rawArgs: unknown) {
    const tool = await import("../tools/import-connector-from-spec.ts");
    return tool.importConnectorFromSpecTool.execute(ctx as never, rawArgs);
  },
};
export type { TurnFailure } from "../turn-failure.ts";
export {
  describeTurnFailure,
  timeoutPhaseOf,
  turnFailureFramePayload,
  workerExpiredTurnFailure,
} from "../turn-failure.ts";
export type { TaskRunCheck, TaskRunMarker, TurnEvent } from "../types.ts";

import type { setConversationLoadedSkills } from "../service/tool-state.ts";
import { importConnectorFromSpecInputSchema } from "../tools/import-connector-from-spec-contract.ts";

export type ConversationSkillScope = Parameters<typeof setConversationLoadedSkills>[1];
export type ConversationLoadedSkills = Parameters<typeof setConversationLoadedSkills>[2];
