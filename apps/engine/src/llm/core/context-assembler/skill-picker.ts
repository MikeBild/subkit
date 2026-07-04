// Skill picker — translate intent signals (attachment MIME types,
// user message keywords, failure flags) into a deduplicated list of
// auto-load skill IDs. Pure dispatch + a single DB hop; no prompt
// rendering, no token accounting.
//
// Lives in its own file — extracted from the parent
// `context-assembler.ts` orchestrator.

import type { Executor } from "../../../db/client.ts";
import { listAutoLoadSkills } from "../../../skills/service.ts";

export async function detectIntentSkills(
  tenant_id: string,
  opts: {
    attachmentMimeTypes?: string[];
    userMessage?: string;
    hasFailedExecution?: boolean;
    hasMultipleConnectors?: boolean;
  },
  exec?: Executor,
): Promise<string[]> {
  const keywords: string[] = [];

  for (const mime of opts.attachmentMimeTypes ?? []) {
    const lower = mime.toLowerCase();
    if (lower.includes("openapi") || lower.includes("yaml") || lower.includes("json")) {
      keywords.push("openapi", "swagger", "yaml", "json");
    }
    if (lower === "application/pdf" || lower.includes("pdf")) keywords.push("pdf");
    if (lower.startsWith("image/")) keywords.push("image", "screenshot", "png", "jpg");
    if (lower.includes("postman")) keywords.push("postman");
    if (lower.includes("graphql") || lower.includes("gql")) keywords.push("graphql");
    if (lower.includes("har")) keywords.push("har");
  }

  const msg = (opts.userMessage ?? "").toLowerCase();
  if (msg.includes("openapi") || msg.includes("swagger")) keywords.push("openapi");
  if (msg.includes("postman")) keywords.push("postman");
  if (msg.includes("graphql")) keywords.push("graphql");
  // External MCP-client integration intents — any MCP-aware client
  // (Codex, Claude Code, Claude Desktop, Cursor, Continue, Zed, Goose,
  // …). Loads the generic `mcp-server-setup` Skill; vendor-specific
  // config shapes live in the VendorRecipeManifest and are fetched
  // per-client via the `get_vendor_recipe` tool, not baked into prose.
  if (
    msg.includes("mcp") ||
    msg.includes("codex") ||
    msg.includes("claude code") ||
    msg.includes("claude desktop") ||
    msg.includes("cursor") ||
    msg.includes("continue") ||
    msg.includes("zed") ||
    msg.includes("goose")
  ) {
    keywords.push(
      "mcp",
      "mcp server",
      "mcp client",
      "model context protocol",
      "codex",
      "claude code",
      "claude desktop",
      "cursor",
      "continue",
      "zed",
      "goose",
    );
  }
  // Connector-creation intent. The `connector-creation-guidance` skill
  // was deliberately narrowed from a broad "api/http/endpoint" trigger
  // to creation-intent phrases only, so we match those phrases here.
  // Mentioning `create connector` / `new connector` pushes the checklist
  // skill; a user talking about an *existing* connector (or authoring
  // against one) does not pay the context cost.
  if (
    msg.includes("create connector") ||
    msg.includes("new connector") ||
    msg.includes("add connector") ||
    msg.includes("create a connector") ||
    msg.includes("add a connector") ||
    msg.includes("create integration") ||
    msg.includes("new integration") ||
    msg.includes("add integration") ||
    msg.includes("set up integration") ||
    msg.includes("configure connector") ||
    msg.includes("start connector")
  ) {
    keywords.push(
      "create connector",
      "new connector",
      "add connector",
      "add integration",
      "new integration",
      "set up integration",
      "configure connector",
      "start connector",
      "start_connector_from_description",
      "start_connector_from_template",
    );
  }
  // Execution-time failure diagnosis keywords — matches
  // `troubleshooting-workflow-failures.md`'s triggers. Pushed when the
  // loop's hasFailedExecution flag is set OR the user's message refers
  // to a past run.
  if (
    opts.hasFailedExecution ||
    msg.includes("execution failed") ||
    msg.includes("run failed") ||
    msg.includes("workflow failed") ||
    msg.includes("past run") ||
    msg.includes("circuit open") ||
    msg.includes("schema_violation") ||
    msg.includes("schema-violation")
  ) {
    keywords.push(
      "troubleshoot",
      "execution failed",
      "run failed",
      "workflow failed",
      "past run",
      "schema-violation",
      "circuit-breaker",
    );
  }
  // Authoring-time tool-error keywords — matches `error-recovery.md`'s
  // triggers. Pushed on explicit error shapes a user might paste OR the
  // model referencing its own failed tool call.
  if (
    msg.includes("error") ||
    msg.includes("failed") ||
    msg.includes("4xx") ||
    msg.includes("5xx") ||
    msg.includes("placeholder_unresolved") ||
    msg.includes("permission_denied") ||
    msg.includes("validation_failed") ||
    msg.includes("step_timeout") ||
    msg.includes("connector_not_found")
  ) {
    keywords.push(
      "error",
      "failed",
      "http_4xx",
      "http_5xx",
      "placeholder_unresolved",
      "permission_denied",
      "validation_failed",
      "step_timeout",
      "connector_not_found",
      "tool error",
    );
  }
  if (opts.hasMultipleConnectors) keywords.push("multi-connector", "orchestration");
  if (keywords.length === 0) keywords.push("onboarding");

  const matched = await listAutoLoadSkills(tenant_id, [...new Set(keywords)], exec);
  return matched.map((s) => s.id);
}
