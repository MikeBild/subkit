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
    const encoded = JSON.stringify(tool.example_input);
    parts.push(`\n<example>\n${encoded}\n</example>`);
  }

  return parts.join("\n").trim();
}
