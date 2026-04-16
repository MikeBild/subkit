// Permission-request router — mirrors Claude Code's
// `permissionComponentForTool()` pattern. Given the engine's
// `PendingApproval` shape, returns a kind-specific inline component
// so a commit_draft renders a structured draft diff, an
// external_write renders the target URL + payload, and an "other"
// falls back to a plain summary + optional diff JSON.
//
// All components are tiny pure-Ink <Box> trees so tests can snapshot
// them without mocking a live stream.

import type { PendingApproval } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { CommitDraftApproval } from "./commit-draft.tsx";
import { ExternalWriteApproval } from "./external-write.tsx";
import { GenericApproval } from "./generic.tsx";

export interface ApprovalRouterProps {
  approval: PendingApproval;
}

export const ApprovalRouter: React.FC<ApprovalRouterProps> = ({ approval }) => {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      padding={1}
      marginBottom={1}
    >
      <Text color="yellow" bold>
        approval required: {approval.kind}
      </Text>
      <Text>{approval.summary}</Text>
      {approval.kind === "commit_draft" ? (
        <CommitDraftApproval diff={approval.diff} />
      ) : approval.kind === "external_write" ? (
        <ExternalWriteApproval target={approval.target} diff={approval.diff} />
      ) : (
        <GenericApproval diff={approval.diff} target={approval.target} />
      )}
      <Text dimColor>
        type `/approve` to allow, `/reject [reason]` to deny (id:{" "}
        <Text dimColor>{approval.id.slice(0, 8)}</Text>)
      </Text>
    </Box>
  );
};
