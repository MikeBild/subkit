// Elicitation router — dispatches on the `ask_user_*` tool family and
// renders a kind-specific inline component. Replaces the old approval
// router: `ask_user_confirm { kind: commit_draft }` renders a
// structured draft diff, `kind: external_write` renders target URL +
// payload, other askUser tools (choice, multi, text, form) fall back
// to a generic summary panel until the full elicit-prompt components
// land in PR 5.

import type { PendingElicitation } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { CommitDraftApproval } from "./commit-draft.tsx";
import { ExternalWriteApproval } from "./external-write.tsx";
import { GenericApproval } from "./generic.tsx";

export interface ApprovalRouterProps {
  approval: PendingElicitation;
}

function readInput(approval: PendingElicitation): Record<string, unknown> {
  return approval.input && typeof approval.input === "object"
    ? (approval.input as Record<string, unknown>)
    : {};
}

export const ApprovalRouter: React.FC<ApprovalRouterProps> = ({ approval }) => {
  const input = readInput(approval);
  const kind = typeof input.kind === "string" ? input.kind : "generic";
  const diff = input.diff;
  const target = input.target;
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
      <Text>{approval.summary}</Text>
      {approval.tool_name === "ask_user_confirm" && kind === "commit_draft" ? (
        <CommitDraftApproval diff={diff} />
      ) : approval.tool_name === "ask_user_confirm" && kind === "external_write" ? (
        <ExternalWriteApproval target={target} diff={diff} />
      ) : (
        <GenericApproval diff={diff} target={target} />
      )}
      <Text dimColor>
        type `/respond {"<value>"}` to answer (id: <Text dimColor>{approval.id.slice(0, 8)}</Text>)
      </Text>
    </Box>
  );
};
