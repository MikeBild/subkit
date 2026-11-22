import { getToolManifest } from "../../manifests/tools.ts";
import type { Scanner, Violation } from "../types.ts";

const BACKTICKED_RE = /`([a-z][a-z0-9_]*)`/g;
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
  "mcp",
  "engine_url",
  "tenant_slug",
  "actor_email",
  "plaintext_key",
  "wf_live_",
]);

function looksLikeToolName(token: string): boolean {
  if (token.length < 4) return false;
  if (token.includes("_")) return true;
  return false;
}

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
    for (const m of text.matchAll(BACKTICKED_RE)) {
      const token = m[1]!;
      if (ALLOW_LIST.has(token)) continue;
      if (!looksLikeToolName(token)) continue;
      if (manifest.names.has(token)) continue;
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
