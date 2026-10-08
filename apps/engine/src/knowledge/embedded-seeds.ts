import codingAgents from "../conversations/seed/knowledge/coding-agents.md" with { type: "text" };
import externalChat from "../conversations/seed/knowledge/external-chat.md" with { type: "text" };
import knowledgeAndSkills from "../conversations/seed/knowledge/knowledge-and-skills.md" with {
  type: "text",
};
import mcpToolCatalog from "../conversations/seed/knowledge/mcp-tool-catalog.md" with {
  type: "text",
};
import restApi from "../conversations/seed/knowledge/rest-api.md" with { type: "text" };
import skCli from "../conversations/seed/knowledge/sk-cli.md" with { type: "text" };
import statusAndCapabilities from "../conversations/seed/knowledge/status-and-capabilities.md" with {
  type: "text",
};
import webhooksAndTriggers from "../conversations/seed/knowledge/webhooks-and-triggers.md" with {
  type: "text",
};

export interface EmbeddedKnowledgeSeedFile {
  file: string;
  content: string;
}

export const EMBEDDED_KNOWLEDGE_SEEDS: readonly EmbeddedKnowledgeSeedFile[] = [
  { file: "coding-agents.md", content: codingAgents },
  { file: "external-chat.md", content: externalChat },
  { file: "knowledge-and-skills.md", content: knowledgeAndSkills },
  { file: "mcp-tool-catalog.md", content: mcpToolCatalog },
  { file: "rest-api.md", content: restApi },
  { file: "sk-cli.md", content: skCli },
  { file: "status-and-capabilities.md", content: statusAndCapabilities },
  { file: "webhooks-and-triggers.md", content: webhooksAndTriggers },
];
