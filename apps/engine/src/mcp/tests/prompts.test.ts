import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PromptListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { globalEmitter } from "../../pubsub/emitter.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
const TEST_NOW_MS = getTestNow();

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
    expect(names).toContain(`skill_${id}`);
    const prompt = list.prompts.find((p) => p.name === `skill_${id}`);
    expect(prompt?.title).toBe("Bake bread");

    const got = await client.getPrompt({ name: `skill_${id}` });
    expect(got.description).toBe("Bake bread");
    // First message carries the body, subsequent messages carry examples.
    expect(got.messages.length).toBe(3);
    const first = got.messages[0]!;
    expect(first.role).toBe("user");
    const firstContent = first.content as { type: string; text: string };
    expect(firstContent.text).toContain("Mix flour");
  });

  test("list exposes arguments and get applies them", async () => {
    const { id } = await suite.seedSkill({
      title: "Bake {{style}} bread",
      body: "Bake {{count}} {{style}} loaves.",
      examples: ["Serve {{style}} warm."],
      arguments: [
        { name: "style", description: "Bread style", required: true },
        { name: "count", description: "Loaf count" },
      ],
    });

    const client = await suite.connect();
    const list = await client.listPrompts();
    const prompt = list.prompts.find((p) => p.name === `skill_${id}`);
    expect(prompt?.arguments).toEqual([
      { name: "style", description: "Bread style", required: true },
      { name: "count", description: "Loaf count" },
    ]);

    const got = await client.getPrompt({
      name: `skill_${id}`,
      arguments: { style: "rye", count: "2" },
    });
    const first = got.messages[0]!.content as { type: string; text: string };
    const second = got.messages[1]!.content as { type: string; text: string };
    expect(first.text).toBe("Bake 2 rye loaves.");
    expect(second.text).toBe("Serve rye warm.");
  });

  test("get rejects missing required and unknown arguments", async () => {
    const { id } = await suite.seedSkill({
      title: "Arg checked",
      body: "Hello {{name}}",
      arguments: [{ name: "name", required: true }],
    });
    const client = await suite.connect();

    await expect(client.getPrompt({ name: `skill_${id}` })).rejects.toThrow(
      /Missing required prompt argument: name/,
    );
    await expect(
      client.getPrompt({ name: `skill_${id}`, arguments: { name: "Ada", extra: "nope" } }),
    ).rejects.toThrow(/Unknown prompt argument: extra/);
  });

  test("list paginates with nextCursor and rejects malformed cursors", async () => {
    for (let i = 0; i < 101; i++) {
      await suite.seedSkill({
        title: `Paged prompt ${i}`,
        body: `Body ${i}`,
        examples: [],
      });
    }
    const client = await suite.connect();
    const first = await client.listPrompts();
    expect(first.prompts).toHaveLength(100);
    expect(typeof first.nextCursor).toBe("string");
    const second = await client.listPrompts({ cursor: first.nextCursor });
    expect(second.prompts.length).toBeGreaterThanOrEqual(1);
    expect(second.nextCursor).toBeUndefined();

    await expect(client.listPrompts({ cursor: "not-base64-json" })).rejects.toThrow(
      /Invalid pagination cursor for prompts\/list/,
    );
  });

  test("skill lifecycle events fire prompt list_changed only within the tenant", async () => {
    const client = await suite.connect();
    let changedCount = 0;
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      changedCount++;
    });

    const { id } = await suite.seedSkill({
      title: "Fresh prompt",
      body: "Fresh body",
      examples: [],
    });

    let dispatchAttempt = 0;
    while (changedCount === 0 && dispatchAttempt < 75) {
      dispatchAttempt++;
      await globalEmitter.dispatch({
        id: dispatchAttempt,
        tenant_id: suite.http.tenantId,
        channel: "skill.lifecycle",
        type: "skill.created",
        payload: { skill_id: id, lifecycle: "active", title: "Fresh prompt" },
        created_at: new Date(TEST_NOW_MS),
      });
      await new Promise((r) => setTimeout(r, 200)); // allow-wall-clock: prompt list_changed debounce
    }
    expect(changedCount).toBeGreaterThanOrEqual(1);

    changedCount = 0;
    await globalEmitter.dispatch({
      id: 999,
      tenant_id: "00000000-0000-0000-0000-0000000000ff",
      channel: "skill.lifecycle",
      type: "skill.created",
      payload: { skill_id: id, lifecycle: "active", title: "Other tenant" },
      created_at: new Date(TEST_NOW_MS),
    });
    await new Promise((r) => setTimeout(r, 400)); // allow-wall-clock: give erroneous notifications time
    expect(changedCount).toBe(0);
  }, 20_000);
});
