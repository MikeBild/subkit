import authFlows from "./seeds/auth-flows.md" with { type: "text" };
import browserPageScrapeQuirks from "./seeds/browser-page-scrape-quirks.md" with { type: "text" };
import codingAgentSetup from "./seeds/coding-agent-setup.md" with { type: "text" };
import connectorCreationGuidance from "./seeds/connector-creation-guidance.md" with {
  type: "text",
};
import dataHandling from "./seeds/data-handling.md" with { type: "text" };
import documentAnalysisGuidance from "./seeds/document-analysis-guidance.md" with { type: "text" };
import domainSetupOnboarding from "./seeds/domain-setup-onboarding.md" with { type: "text" };
import engineRestApi from "./seeds/engine-rest-api.md" with { type: "text" };
import engineStatusAndCapabilities from "./seeds/engine-status-and-capabilities.md" with {
  type: "text",
};
import errorRecovery from "./seeds/error-recovery.md" with { type: "text" };
import externalChatIntegration from "./seeds/external-chat-integration.md" with { type: "text" };
import githubGraphqlBasics from "./seeds/github-graphql-basics.md" with { type: "text" };
import gmailReportAutomation from "./seeds/gmail-report-automation.md" with { type: "text" };
import governedDelivery from "./seeds/governed-delivery.md" with { type: "text" };
import graphqlAuthoringRecipe from "./seeds/graphql-authoring-recipe.md" with { type: "text" };
import graphqlConnectors from "./seeds/graphql-connectors.md" with { type: "text" };
import httpConnectors from "./seeds/http-connectors.md" with { type: "text" };
import intakeReviewToKnowledge from "./seeds/intake-review-to-knowledge.md" with { type: "text" };
import knowledgeFindAndMaintain from "./seeds/knowledge-find-and-maintain.md" with { type: "text" };
import localWorkflowSteps from "./seeds/local-workflow-steps.md" with { type: "text" };
import mcpServerSetup from "./seeds/mcp-server-setup.md" with { type: "text" };
import mcpToolContract from "./seeds/mcp-tool-contract.md" with { type: "text" };
import multiStepBestPractices from "./seeds/multi-step-best-practices.md" with { type: "text" };
import openAuthorizationFlow from "./seeds/oauth-flow.md" with { type: "text" };
import onboardingWorkflowCreation from "./seeds/onboarding-workflow-creation.md" with {
  type: "text",
};
import postgresConnectors from "./seeds/postgres-connectors.md" with { type: "text" };
import rbacAndScopes from "./seeds/rbac-and-scopes.md" with { type: "text" };
import s3Connectors from "./seeds/s3-connectors.md" with { type: "text" };
import selfHealing from "./seeds/self-healing.md" with { type: "text" };
import skCliReference from "./seeds/sk-cli-reference.md" with { type: "text" };
import subkitConcepts from "./seeds/subkit-concepts.md" with { type: "text" };
import troubleshootingWorkflowFailures from "./seeds/troubleshooting-workflow-failures.md" with {
  type: "text",
};
import webhooksAndTriggers from "./seeds/webhooks-and-triggers.md" with { type: "text" };
import whenSomethingIsStuck from "./seeds/when-something-is-stuck.md" with { type: "text" };
import workflowAuthoring from "./seeds/workflow-authoring.md" with { type: "text" };
import workflowAuthoringAutomation from "./seeds/workflow-authoring-automation.md" with {
  type: "text",
};
import workflowAuthoringBoundaries from "./seeds/workflow-authoring-boundaries.md" with {
  type: "text",
};
import workflowAuthoringLoopExamples from "./seeds/workflow-authoring-loop-examples.md" with {
  type: "text",
};
import workflowAuthoringOutputFormat from "./seeds/workflow-authoring-output-format.md" with {
  type: "text",
};
import workflowAuthoringProductCallers from "./seeds/workflow-authoring-product-callers.md" with {
  type: "text",
};
import workflowAuthoringRepair from "./seeds/workflow-authoring-repair.md" with { type: "text" };
import workflowAuthoringSchedules from "./seeds/workflow-authoring-schedules.md" with {
  type: "text",
};
import workflowAuthoringStructures from "./seeds/workflow-authoring-structures.md" with {
  type: "text",
};
import workflowAuthoringTransactionalMail from "./seeds/workflow-authoring-transactional-mail.md" with {
  type: "text",
};
import workflowAuthoringTransforms from "./seeds/workflow-authoring-transforms.md" with {
  type: "text",
};
import workflowFindRunCheck from "./seeds/workflow-find-run-check.md" with { type: "text" };
import workingOnATask from "./seeds/working-on-a-task.md" with { type: "text" };

interface EmbeddedSeedFile {
  file: string;
  content: string;
}

export const EMBEDDED_SKILL_SEEDS: readonly EmbeddedSeedFile[] = [
  { file: "auth-flows.md", content: authFlows },
  { file: "browser-page-scrape-quirks.md", content: browserPageScrapeQuirks },
  { file: "coding-agent-setup.md", content: codingAgentSetup },
  { file: "connector-creation-guidance.md", content: connectorCreationGuidance },
  { file: "data-handling.md", content: dataHandling },
  { file: "document-analysis-guidance.md", content: documentAnalysisGuidance },
  { file: "domain-setup-onboarding.md", content: domainSetupOnboarding },
  { file: "engine-rest-api.md", content: engineRestApi },
  { file: "engine-status-and-capabilities.md", content: engineStatusAndCapabilities },
  { file: "error-recovery.md", content: errorRecovery },
  { file: "external-chat-integration.md", content: externalChatIntegration },
  { file: "github-graphql-basics.md", content: githubGraphqlBasics },
  { file: "gmail-report-automation.md", content: gmailReportAutomation },
  { file: "governed-delivery.md", content: governedDelivery },
  { file: "graphql-authoring-recipe.md", content: graphqlAuthoringRecipe },
  { file: "graphql-connectors.md", content: graphqlConnectors },
  { file: "http-connectors.md", content: httpConnectors },
  { file: "intake-review-to-knowledge.md", content: intakeReviewToKnowledge },
  { file: "knowledge-find-and-maintain.md", content: knowledgeFindAndMaintain },
  { file: "local-workflow-steps.md", content: localWorkflowSteps },
  { file: "mcp-server-setup.md", content: mcpServerSetup },
  { file: "mcp-tool-contract.md", content: mcpToolContract },
  { file: "multi-step-best-practices.md", content: multiStepBestPractices },
  { file: "oauth-flow.md", content: openAuthorizationFlow },
  { file: "onboarding-workflow-creation.md", content: onboardingWorkflowCreation },
  { file: "postgres-connectors.md", content: postgresConnectors },
  { file: "rbac-and-scopes.md", content: rbacAndScopes },
  { file: "s3-connectors.md", content: s3Connectors },
  { file: "self-healing.md", content: selfHealing },
  { file: "sk-cli-reference.md", content: skCliReference },
  { file: "subkit-concepts.md", content: subkitConcepts },
  { file: "troubleshooting-workflow-failures.md", content: troubleshootingWorkflowFailures },
  { file: "webhooks-and-triggers.md", content: webhooksAndTriggers },
  { file: "when-something-is-stuck.md", content: whenSomethingIsStuck },
  { file: "workflow-authoring-automation.md", content: workflowAuthoringAutomation },
  { file: "workflow-authoring-boundaries.md", content: workflowAuthoringBoundaries },
  { file: "workflow-authoring-loop-examples.md", content: workflowAuthoringLoopExamples },
  { file: "workflow-authoring-output-format.md", content: workflowAuthoringOutputFormat },
  { file: "workflow-authoring-product-callers.md", content: workflowAuthoringProductCallers },
  { file: "workflow-authoring-repair.md", content: workflowAuthoringRepair },
  { file: "workflow-authoring-schedules.md", content: workflowAuthoringSchedules },
  { file: "workflow-authoring-structures.md", content: workflowAuthoringStructures },
  { file: "workflow-authoring-transactional-mail.md", content: workflowAuthoringTransactionalMail },
  { file: "workflow-authoring-transforms.md", content: workflowAuthoringTransforms },
  { file: "workflow-authoring.md", content: workflowAuthoring },
  { file: "workflow-find-run-check.md", content: workflowFindRunCheck },
  { file: "working-on-a-task.md", content: workingOnATask },
];
