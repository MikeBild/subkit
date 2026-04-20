// Tool ref scanner — flags assistant narration that mentions a
// snake_case tool name in backticks where no such tool is registered.
//
// Catches "I've prompted a form" / "I'll call create_oauth_app"-style
// hallucinations. Only backticked names are evaluated to keep false
// positives low: the assistant uses `tool_name` in code-style spans
// when it means a tool, and free-form text otherwise.

import { getToolManifest } from "../../manifests/tools.ts";
import type { Scanner, Violation } from "../types.ts";

const BACKTICKED_RE = /`([a-z][a-z0-9_]*)`/g;
// Words that are commonly backticked but are not tool names — keep
// the scanner from flagging them.
const ALLOW_LIST: ReadonlySet<string> = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "json",
  "yaml",
  "markdown",
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "this",
  "self",
  "subkit",
  "sk",
  "mcp",
  "engine_url",
  "tenant_slug",
  "actor_email",
  "plaintext_key",
  "wf_live_",
]);

function looksLikeToolName(token: string): boolean {
  // Tool names are snake_case, at least one underscore (rules out
  // single words like `json`) OR a known tool-shape verb prefix.
  if (token.length < 4) return false;
  if (token.includes("_")) return true;
  return false;
}

export const toolScanner: Scanner = {
  id: "tool",
  scan(text: string): Violation[] {
    const out: Violation[] = [];
    const manifest = getToolManifest();
    BACKTICKED_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
    while ((m = BACKTICKED_RE.exec(text)) !== null) {
      const token = m[1]!;
      if (ALLOW_LIST.has(token)) continue;
      if (!looksLikeToolName(token)) continue;
      if (manifest.names.has(token)) continue;
      out.push({
        kind: "tool.phantom_reference",
        message: `Narrated a call to \`${token}\` but no such tool is registered.`,
        span: { start: m.index, end: m.index + m[0].length },
        details: { invented_tool: token },
      });
    }
    return out;
  },
};
