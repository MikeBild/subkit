// Build-time embedded knowledge-seed bundle.
//
// Each Markdown source is imported as text via the `with { type: "text" }`
// import attribute, so `bun build --compile` inlines the file contents into
// the binary. There is no runtime `fs.readdir` and no fallback search path;
// the seeds ship with the binary, period.
//
// README.md (if present) intentionally has no entry — it is documentation
// for the seed authors, not an ingestible Knowledge Source.

import externalChat from "../conversations/seed/knowledge/external-chat.md" with { type: "text" };
import knowledgeAndSkills from "../conversations/seed/knowledge/knowledge-and-skills.md" with { type: "text" };
import mcpToolCatalog from "../conversations/seed/knowledge/mcp-tool-catalog.md" with { type: "text" };
import restApi from "../conversations/seed/knowledge/rest-api.md" with { type: "text" };
import skCli from "../conversations/seed/knowledge/sk-cli.md" with { type: "text" };
import statusAndCapabilities from "../conversations/seed/knowledge/status-and-capabilities.md" with { type: "text" };
import webhooksAndTriggers from "../conversations/seed/knowledge/webhooks-and-triggers.md" with { type: "text" };

export interface EmbeddedKnowledgeSeedFile {
  /** Source filename (e.g. "rest-api.md"). Used for typed parse-error
   *  reporting that points an operator back to the on-disk source. */
  file: string;
  /** Full file contents — raw frontmatter + markdown body. */
  content: string;
}

/**
 * Sorted alphabetically so embedded order is deterministic across builds.
 * Tests rely on a stable iteration order without re-sorting.
 */
export const EMBEDDED_KNOWLEDGE_SEEDS: readonly EmbeddedKnowledgeSeedFile[] = [
  { file: "external-chat.md", content: externalChat },
  { file: "knowledge-and-skills.md", content: knowledgeAndSkills },
  { file: "mcp-tool-catalog.md", content: mcpToolCatalog },
  { file: "rest-api.md", content: restApi },
  { file: "sk-cli.md", content: skCli },
  { file: "status-and-capabilities.md", content: statusAndCapabilities },
  { file: "webhooks-and-triggers.md", content: webhooksAndTriggers },
];
