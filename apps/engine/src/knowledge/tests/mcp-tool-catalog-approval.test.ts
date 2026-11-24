import { describe, expect, test } from "bun:test";
import mcpCatalogGolden from "../../api/operations/tests/fixtures/mcp-catalog.golden.json";
import { EMBEDDED_KNOWLEDGE_SEEDS } from "../embedded-seeds.ts";

const catalogSeed =
  EMBEDDED_KNOWLEDGE_SEEDS.find((seedFile) => seedFile.file === "mcp-tool-catalog.md")?.content ??
  "";

const sectionAfterHeading = (markdown: string, heading: string): string => {
  const startIndex = markdown.indexOf(`\n# ${heading}\n`);
  if (startIndex < 0) return "";
  const rest = markdown.slice(startIndex + heading.length + 4);
  const nextHeadingIndex = rest.search(/\n# /);
  return nextHeadingIndex < 0 ? rest : rest.slice(0, nextHeadingIndex);
};

const goldenToolNames: readonly string[] = JSON.parse(mcpCatalogGolden["http.tools"]).names;
const approvalGateSection = sectionAfterHeading(catalogSeed, "Write Approval Gate");

describe("sk-ref-mcp-tools write approval gate", () => {
  test("the seed carries a Write Approval Gate section", () => {
    expect(catalogSeed).toContain("slug: sk-ref-mcp-tools");
    expect(approvalGateSection.length).toBeGreaterThan(0);
  });

  test("describes the needs_confirm, approval_url and confirm_tool_call flow", () => {
    expect(goldenToolNames).toContain("confirm_tool_call");
    for (const term of ["needs_confirm", "tool_call_id", "approval_url", "confirm_tool_call"]) {
      expect(approvalGateSection).toContain(term);
    }
  });

  test("does not claim the confirm flow was removed while confirm_tool_call is published", () => {
    expect(goldenToolNames).toContain("confirm_tool_call");
    expect(approvalGateSection).not.toMatch(/were removed/i);
    expect(approvalGateSection).not.toMatch(/no subkit-side approval portal/i);
    expect(approvalGateSection).not.toMatch(/executes directly/i);
  });
});
