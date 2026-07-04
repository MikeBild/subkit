// Strip leaked tool-call markup from assistant text.
//
// A weaker model — or a turn where tools were withheld — sometimes
// emits tool-call SYNTAX in its text channel instead of the structured
// tool_use channel, e.g.:
//
//   Knowledge sources: checking now.
//   <function_calls>
//   <invoke name="list_knowledge_sources"></invoke>
//   </function_calls>
//
// That markup is never legitimate assistant prose — it is a malformed
// tool call that leaked into the transcript. Like the secret pre-pass in
// the output guard, this runs in EVERY guard mode (a correctness
// invariant, not a policy choice). The match shapes are deliberately
// tight (`<function_calls>` exactly, or `<invoke name=…>`) so ordinary
// prose that merely mentions a tool name in backticks is never touched.

const CLOSED_BLOCK_RES: RegExp[] = [
  // `<function_calls>…</function_calls>` and the antml:-namespaced
  // variant, closed form (removes the inner <invoke> too).
  /<(?:antml:)?function_calls>[\s\S]*?<\/(?:antml:)?function_calls>/gi,
  // A stray `<invoke name="…">…</invoke>` not wrapped in function_calls.
  /<(?:antml:)?invoke\s+name=[\s\S]*?<\/(?:antml:)?invoke>/gi,
];

// A truncated leak — an opener with no matching close. Strip to EOT.
const DANGLING_RE = /<(?:antml:)?(?:function_calls>|invoke\s+name=)[\s\S]*$/i;

export function stripLeakedToolCallMarkup(text: string): { text: string; stripped: number } {
  if (!text.includes("<")) return { text, stripped: 0 };
  let out = text;
  let stripped = 0;
  for (const re of CLOSED_BLOCK_RES) {
    out = out.replace(re, () => {
      stripped += 1;
      return "";
    });
  }
  if (DANGLING_RE.test(out)) {
    out = out.replace(DANGLING_RE, () => {
      stripped += 1;
      return "";
    });
  }
  if (stripped > 0) {
    // Collapse the blank lines the removed block left behind so the
    // surrounding prose still reads cleanly.
    out = out
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\s+$/, "");
  }
  return { text: out, stripped };
}
