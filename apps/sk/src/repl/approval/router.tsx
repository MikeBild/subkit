// Elicitation router — dispatches on the `ask_user_*` tool family and
// renders a kind-specific inline component. Replaces the old approval
// router: `ask_user_confirm { kind: commit_draft }` renders a
// structured draft diff, `kind: external_write` renders target URL +
// payload, other askUser tools (choice, multi, text, form) fall back
// to a generic summary panel until the full elicit-prompt components
// land in PR 5.
//
// When the elicitation carries a mutating `commit_intent`
// (`save_connector_draft` / `commit_workflow_draft` / `update_connector`
// / `update_workflow`), the router routes to `GenericApproval` and
// passes the `commit_intent` + `engineClient` so the upgraded
// structured-diff view renders. Otherwise the legacy CommitDraft /
// ExternalWrite renderers run unchanged.

import type { PendingElicitation } from "@cli-core/index.ts";
import type { CommitIntent } from "@engine/conversations/tools/ask-user/commit-intent.ts";
import { Box, Text } from "ink";
import type React from "react";
import type { EngineClient } from "../../engine-client.ts";
import { CommitDraftApproval } from "./commit-draft.tsx";
import { describeConfirmationPayload } from "./describe-confirmation.ts";
import { ExternalWriteApproval } from "./external-write.tsx";
import { GenericApproval } from "./generic.tsx";

export interface ApprovalRouterProps {
  approval: PendingElicitation;
  /**
   * Optional engine client. When provided alongside a mutating
   * `commit_intent`, GenericApproval fetches the current persisted
   * state and renders a structured JsonDiff.
   */
  engineClient?: EngineClient | undefined;
  /** Disable nested input handlers (used by snapshot tests). */
  inputDisabled?: boolean | undefined;
}

const STRUCTURED_DIFF_INTENT_KINDS: ReadonlySet<string> = new Set([
  "save_connector_draft",
  "commit_workflow_draft",
  "update_connector",
  "update_workflow",
]);

function readInput(approval: PendingElicitation): Record<string, unknown> {
  return approval.input && typeof approval.input === "object"
    ? (approval.input as Record<string, unknown>)
    : {};
}

function readCommitIntent(input: Record<string, unknown>): CommitIntent | undefined {
  const ci = input.commit_intent;
  if (!ci || typeof ci !== "object") return undefined;
  const obj = ci as Record<string, unknown>;
  const kind = typeof obj.kind === "string" ? obj.kind : null;
  const description = typeof obj.description === "string" ? obj.description : null;
  const payload = obj.payload && typeof obj.payload === "object" ? obj.payload : null;
  if (!kind || !description || !payload) return undefined;
  return {
    kind,
    description,
    payload: payload as Record<string, unknown>,
  } as CommitIntent;
}

export const ApprovalRouter: React.FC<ApprovalRouterProps> = ({
  approval,
  engineClient,
  inputDisabled,
}) => {
  const input = readInput(approval);
  const kind = typeof input.kind === "string" ? input.kind : "generic";
  const diff = input.diff;
  const target = input.target;
  const commitIntent = readCommitIntent(input);
  const useStructuredDiff =
    approval.tool_name === "ask_user_confirm" &&
    commitIntent != null &&
    STRUCTURED_DIFF_INTENT_KINDS.has(commitIntent.kind);
  const summaryText =
    approval.summary.trim() || describeConfirmationPayload(input) || approval.tool_name;
  const headerLabel =
    approval.tool_name === "ask_user_confirm" ? `confirm: ${kind}` : approval.tool_name;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      padding={1}
      marginBottom={1}
    >
      <Text color="yellow" bold>
        input needed: {headerLabel}
      </Text>
      <Text>{summaryText}</Text>
      {useStructuredDiff ? (
        <GenericApproval
          diff={diff}
          target={target}
          commitIntent={commitIntent}
          engineClient={engineClient}
          inputDisabled={inputDisabled}
        />
      ) : approval.tool_name === "ask_user_confirm" && kind === "commit_draft" ? (
        <CommitDraftApproval diff={diff} />
      ) : approval.tool_name === "ask_user_confirm" && kind === "external_write" ? (
        <ExternalWriteApproval target={target} diff={diff} />
      ) : (
        <GenericApproval diff={diff} target={target} inputDisabled={inputDisabled} />
      )}
      <Text dimColor>
        type `/respond {"<value>"}` to answer (id: <Text dimColor>{approval.id.slice(0, 8)}</Text>)
      </Text>
    </Box>
  );
};
