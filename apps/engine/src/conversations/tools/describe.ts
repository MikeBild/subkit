// Tool description compiler.
//
// The LLM sees tool descriptions as plain text in the tool-use schema.
// To give it a structured, discoverable catalogue without bloating the
// system prompt, we fold four optional metadata channels (use_case,
// important_notes, requires_skill, example_input) into XML-tagged
// sections appended to the base description.
//
// Example output:
//
//     Fetch a single connector by id …
//
//     <use_case>Use before authoring a step that calls this connector …</use_case>
//
//     <important_notes>
//     - Returns placeholder tokens for URL / credentials / config.
//     - Issues a `connector:read` RBAC check; low-privilege principals …
//     </important_notes>
//
//     <requires_skill>http-connectors</requires_skill>
//
//     <example>
//     {"id":"c0f1…-…"}
//     </example>
//
// The function is pure; it emits an empty string for empty metadata. A
// null input renders just the base description, unchanged.

import type { ConversationTool } from "./index.ts";

export function compileDescription(tool: ConversationTool): string {
  const parts: string[] = [tool.description.trim()];

  if (tool.use_case && tool.use_case.trim().length > 0) {
    parts.push(`\n<use_case>${tool.use_case.trim()}</use_case>`);
  }

  if (tool.important_notes && tool.important_notes.length > 0) {
    const bullets = tool.important_notes.map((n) => `- ${n.trim()}`).join("\n");
    parts.push(`\n<important_notes>\n${bullets}\n</important_notes>`);
  }

  if (tool.requires_skill && tool.requires_skill.trim().length > 0) {
    parts.push(`\n<requires_skill>${tool.requires_skill.trim()}</requires_skill>`);
  }

  if (tool.example_input && Object.keys(tool.example_input).length > 0) {
    // Pretty-printing bloats the description; a single-line example is
    // easier for the model to parse.
    const encoded = JSON.stringify(tool.example_input);
    parts.push(`\n<example>\n${encoded}\n</example>`);
  }

  return parts.join("\n").trim();
}
