// Tests for the H2/H3 conversation tools: search_knowledge, list_skill_suggestions.
// These are unit tests that verify the tool registration and basic execution.

import { describe, expect, test } from "bun:test";
import { getTool, listTools } from "../tools/index.ts";

describe("conversation tools — H2/H3 registration", () => {
  test("all 13 tools are registered", () => {
    const tools = listTools();
    expect(tools.length).toBe(13);
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
