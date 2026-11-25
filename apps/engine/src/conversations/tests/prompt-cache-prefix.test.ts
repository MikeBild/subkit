import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors, conversations } from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { runLoop } from "../loop/index.ts";

const RECIPES = [
  { slug: "export-invoices", keyword: "invoices" },
  { slug: "sync-customers", keyword: "customers" },
  { slug: "archive-orders", keyword: "orders" },
  { slug: "report-tickets", keyword: "tickets" },
].map(({ slug, keyword }) => ({
  slug,
  title: `Recipe ${slug}`,
  description: `Handles ${keyword}.`,
  intent_keywords: [keyword],
  workflow: { name: slug, slug, steps: [] },
}));

interface WirePrefix {
  tools: Array<{ name: string }>;
  system: { content: string } | null;
}

let ctx: LlmTestCtx;
beforeAll(async () => {
  ctx = await createLlmTestCtx("prompt_cache_prefix");
  await ctx.testDb.db
    .update(connectors)
    .set({ template_snapshot: { slug: "prefix-template", recipes: RECIPES } })
    .where(eq(connectors.id, ctx.connector_id));
});
afterAll(async () => {
  await ctx?.cleanup();
});
beforeEach(() => {
  resetMockProvider();
});

async function newConversation(): Promise<string> {
  const [conversation] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning();
  if (!conversation) throw new Error("missing conversation");
  return conversation.id;
}

async function turn(
  conversation_id: string,
  user_message: string,
  connector_id: string | null,
): Promise<string> {
  const mock = getMockProvider();
  const before = mock.cachePrefixes.length;
  mock.setConversePlan(conversation_id, [{ text: `Answer to ${user_message}` }]);
  await runLoop({
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: null,
    connector_id,
    workflow_id: null,
    user_message,
    turn_abort_ctrl: new AbortController(),
    surface: "web",
    step_budget: 2,
  });
  const prefix = mock.cachePrefixes[before];
  if (prefix === undefined) throw new Error("the turn sent no model call");
  return prefix;
}

describe("the prompt prefix up to the cache breakpoint", () => {
  test("is byte-equal across two consecutive turns of one conversation", async () => {
    const conversation_id = await newConversation();
    const first = await turn(conversation_id, "Which workflows do I have?", null);
    const second = await turn(conversation_id, "And which connectors are set up?", null);
    expect(second).toBe(first);
  });

  test("stays byte-equal when the turns rank different connector recipes", async () => {
    const conversation_id = await newConversation();
    const first = await turn(conversation_id, "Export the invoices please", ctx.connector_id);
    const second = await turn(conversation_id, "Now sync the customers", ctx.connector_id);
    expect(second).toBe(first);
    expect(first).not.toContain("# Recipe bodies");
  });

  test("lists the tools in alphabetical order", async () => {
    const conversation_id = await newConversation();
    const prefix = JSON.parse(await turn(conversation_id, "Hello", null)) as WirePrefix;
    const names = prefix.tools.map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(1);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});
