// Tests for conversation tool registration — covers the H2/H3 tools
// (search_knowledge, list_skill_suggestions, propose_*) plus the
// `ask_user_*` family that paused-loop elicitations dispatch through.

import { describe, expect, test } from "bun:test";
import { getTool, listTools } from "../tools/index.ts";

describe("conversation tools — registration", () => {
  test("the expected tool palette is registered", () => {
    const tools = listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "ask_user_choice",
        "ask_user_confirm",
        "ask_user_form",
        "ask_user_multi",
        "ask_user_text",
        "commit_draft",
        "connect_steps",
        "dry_run_step",
        "fetch_connector_docs",
        "list_skill_suggestions",
        "list_skills",
        "propose_connector",
        "propose_skill",
        "propose_step",
        "search_knowledge",
        "update_param",
        "validate_draft",
      ].sort(),
    );
  });

  test("search_knowledge tool is registered", () => {
    const tool = getTool("search_knowledge");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("search_knowledge");
    expect(tool!.description).toContain("Knowledge Sources");
  });

  test("list_skill_suggestions tool is registered", () => {
    const tool = getTool("list_skill_suggestions");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("list_skill_suggestions");
    expect(tool!.description).toContain("skill");
  });

  test("propose_connector tool is registered", () => {
    const tool = getTool("propose_connector");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("propose_connector");
    expect(tool!.description).toContain("Connector");
  });

  test("propose_skill tool is registered", () => {
    const tool = getTool("propose_skill");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("propose_skill");
    expect(tool!.description).toContain("Skill");
  });

  test("tool names are unique", () => {
    const tools = listTools();
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test("all tools have inputSchema", () => {
    const tools = listTools();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
    }
  });

  test("all tools have execute function", () => {
    const tools = listTools();
    for (const tool of tools) {
      expect(typeof tool.execute).toBe("function");
    }
  });
});
