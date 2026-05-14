// Build-time embedded skill-seed bundle.
//
// Each Markdown skill is imported as text via the
// `with { type: "text" }` import attribute, so `bun build --compile`
// inlines the file contents into the binary. There is no runtime
// `fs.readdir` and no fallback search path; the seeds ship with the
// binary, period.
//
// README.md intentionally has no entry — the loader filters it out.

import authFlows from "../conversations/seed/skills/auth-flows.md" with { type: "text" };
import connectorCreationGuidance from "../conversations/seed/skills/connector-creation-guidance.md" with {
  type: "text",
};
import dataHandling from "../conversations/seed/skills/data-handling.md" with { type: "text" };
import documentAnalysisGuidance from "../conversations/seed/skills/document-analysis-guidance.md" with {
  type: "text",
};
import errorRecovery from "../conversations/seed/skills/error-recovery.md" with { type: "text" };
import fileTransportConnectors from "../conversations/seed/skills/file-transport-connectors.md" with {
  type: "text",
};
import githubGraphqlBasics from "../conversations/seed/skills/github-graphql-basics.md" with {
  type: "text",
};
import graphqlConnectors from "../conversations/seed/skills/graphql-connectors.md" with {
  type: "text",
};
import httpConnectors from "../conversations/seed/skills/http-connectors.md" with { type: "text" };
import mcpServerSetup from "../conversations/seed/skills/mcp-server-setup.md" with { type: "text" };
import mcpToolContract from "../conversations/seed/skills/mcp-tool-contract.md" with {
  type: "text",
};
import mssqlConnectors from "../conversations/seed/skills/mssql-connectors.md" with {
  type: "text",
};
import multiStepBestPractices from "../conversations/seed/skills/multi-step-best-practices.md" with {
  type: "text",
};
import oauthFlow from "../conversations/seed/skills/oauth-flow.md" with { type: "text" };
import onboardingWorkflowCreation from "../conversations/seed/skills/onboarding-workflow-creation.md" with {
  type: "text",
};
import postgresConnectors from "../conversations/seed/skills/postgres-connectors.md" with {
  type: "text",
};
import rbacAndScopes from "../conversations/seed/skills/rbac-and-scopes.md" with { type: "text" };
import redisConnectors from "../conversations/seed/skills/redis-connectors.md" with {
  type: "text",
};
import s3Connectors from "../conversations/seed/skills/s3-connectors.md" with { type: "text" };
import selfHealing from "../conversations/seed/skills/self-healing.md" with { type: "text" };
import subkitConcepts from "../conversations/seed/skills/subkit-concepts.md" with { type: "text" };
import troubleshootingWorkflowFailures from "../conversations/seed/skills/troubleshooting-workflow-failures.md" with {
  type: "text",
};
import workflowAuthoring from "../conversations/seed/skills/workflow-authoring.md" with {
  type: "text",
};

export interface EmbeddedSeedFile {
  /** Source filename (e.g. "auth-flows.md"). Used for typed parse-error
   *  reporting that points an operator back to the on-disk source. */
  file: string;
  /** Full file contents — raw frontmatter + markdown body. */
  content: string;
}

/**
 * Sorted alphabetically so embedded order is deterministic across
 * builds. Tests rely on a stable iteration order without re-sorting.
 */
export const EMBEDDED_SKILL_SEEDS: readonly EmbeddedSeedFile[] = [
  { file: "auth-flows.md", content: authFlows },
  { file: "connector-creation-guidance.md", content: connectorCreationGuidance },
  { file: "data-handling.md", content: dataHandling },
  { file: "document-analysis-guidance.md", content: documentAnalysisGuidance },
  { file: "error-recovery.md", content: errorRecovery },
  { file: "file-transport-connectors.md", content: fileTransportConnectors },
  { file: "github-graphql-basics.md", content: githubGraphqlBasics },
  { file: "graphql-connectors.md", content: graphqlConnectors },
  { file: "http-connectors.md", content: httpConnectors },
  { file: "mcp-server-setup.md", content: mcpServerSetup },
  { file: "mcp-tool-contract.md", content: mcpToolContract },
  { file: "mssql-connectors.md", content: mssqlConnectors },
  { file: "multi-step-best-practices.md", content: multiStepBestPractices },
  { file: "oauth-flow.md", content: oauthFlow },
  { file: "onboarding-workflow-creation.md", content: onboardingWorkflowCreation },
  { file: "postgres-connectors.md", content: postgresConnectors },
  { file: "rbac-and-scopes.md", content: rbacAndScopes },
  { file: "redis-connectors.md", content: redisConnectors },
  { file: "s3-connectors.md", content: s3Connectors },
  { file: "self-healing.md", content: selfHealing },
  { file: "subkit-concepts.md", content: subkitConcepts },
  { file: "troubleshooting-workflow-failures.md", content: troubleshootingWorkflowFailures },
  { file: "workflow-authoring.md", content: workflowAuthoring },
];
