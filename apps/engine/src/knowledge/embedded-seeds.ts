import codingAgents from "./seeds/coding-agents.md" with { type: "text" };
import externalChat from "./seeds/external-chat.md" with { type: "text" };
import knowledgeAndSkills from "./seeds/knowledge-and-skills.md" with { type: "text" };
import mcpToolCatalog from "./seeds/mcp-tool-catalog.md" with { type: "text" };
import restApi from "./seeds/rest-api.md" with { type: "text" };
import skCli from "./seeds/sk-cli.md" with { type: "text" };
import statusAndCapabilities from "./seeds/status-and-capabilities.md" with { type: "text" };
import webhooksAndTriggers from "./seeds/webhooks-and-triggers.md" with { type: "text" };

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
