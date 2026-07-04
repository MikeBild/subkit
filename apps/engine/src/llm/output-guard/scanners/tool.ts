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

// Verbs that put a following backticked token in an *invocation*
// context — "I'll call `create_oauth_app`", "running `dry_run_step`".
// A bare backticked identifier with no invocation verb before it is a
// legitimate reference (a step id, an audit reason, an error code, a
// field name) and must NOT be flagged. The verb is matched on a word
// boundary, case-insensitively, within a short window of text
// immediately before the backtick.
const INVOCATION_VERB_RE =
  /\b(call|calls|called|calling|invoke|invokes|invoked|invoking|dispatch|dispatched|dispatching|trigger|triggered|triggering|prompt|prompted|prompting|run|running)\b[\s:,\-—–]*$/i;
const INVOCATION_WINDOW = 40;

function inInvocationContext(text: string, matchStart: number): boolean {
  const windowStart = Math.max(0, matchStart - INVOCATION_WINDOW);
  const before = text.slice(windowStart, matchStart);
  return INVOCATION_VERB_RE.test(before);
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
      // Only flag a token the model presents as an actual invocation —
      // a backticked identifier with no invocation verb before it is a
      // legitimate reference (step id, audit reason, error code).
      if (!inInvocationContext(text, m.index)) continue;
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
