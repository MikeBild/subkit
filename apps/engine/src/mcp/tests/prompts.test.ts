import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("prompts");
});

afterAll(async () => {
  await suite.cleanup();
});

describe("mcp prompts", () => {
  test("list + get a skill", async () => {
    const { id } = await suite.seedSkill({
      title: "Bake bread",
      body: "Mix flour, water, salt; bake at 230C for 30 min.",
      examples: ["sourdough", "focaccia"],
    });
    const client = await suite.connect();
    const list = await client.listPrompts();
    const names = list.prompts.map((p) => p.name);
    expect(names).toContain(`skill.${id}`);

    const got = await client.getPrompt({ name: `skill.${id}` });
    expect(got.description).toBe("Bake bread");
    // First message carries the body, subsequent messages carry examples.
    expect(got.messages.length).toBe(3);
    const first = got.messages[0]!;
    expect(first.role).toBe("user");
    const firstContent = first.content as { type: string; text: string };
    expect(firstContent.text).toContain("Mix flour");
  });
});
