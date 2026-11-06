import { afterAll, beforeAll, expect, test } from "bun:test";
import { conversationMessages, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { buildModelMessages } from "../persistence/index.ts";

let ctx: TestDb;
let tenant: string;
beforeAll(async () => {
  ctx = await createTestDb("replay_instructions");
  const [row] = await ctx.db
    .insert(tenants)
    .values({ slug: "instructions", display_name: "Instructions" })
    .returning();
  if (!row) throw new Error("missing tenant");
  tenant = row.id;
});
afterAll(async () => {
  await ctx?.cleanup();
});

test("long authoring history preserves the full opening request and later restrictions", async () => {
  const [row] = await ctx.db
    .insert(conversations)
    .values({ tenant_id: tenant, status: "active" })
    .returning();
  if (!row) throw new Error("missing conversation");
  const goal = `${"A detailed weekly report. ".repeat(20)}Use only GitHub https://github.com/MikeBild/subkit/wiki/launch. Monday 08:00 Europe/Berlin. Never send an email.`;
  const correction = "Retain all five existing steps. Save an inactive draft only.";
  const base = Date.parse("2026-04-01T00:00:00Z");
  const messages = [
    { role: "user" as const, content: { text: goal } },
    ...Array.from({ length: 30 }, (_, i) => ({
      role: "assistant" as const,
      content: { text: `operation ${i}` },
    })),
    { role: "user" as const, content: { text: correction } },
  ];
  await ctx.db.insert(conversationMessages).values(
    messages.map((message, i) => ({
      ...message,
      tenant_id: tenant,
      conversation_id: row.id,
      created_at: new Date(base + i * 1000),
    })),
  );
  const before = await buildModelMessages(ctx.db, tenant, row.id);
  expect(before.some((message) => message.role === "user" && message.content === goal)).toBe(true);
  expect(before.some((message) => message.role === "user" && message.content === correction)).toBe(
    true,
  );
  await ctx.db.insert(conversationMessages).values({
    tenant_id: tenant,
    conversation_id: row.id,
    role: "system",
    content: { kind: "compacted", summary: "A report is being prepared." },
    created_at: new Date(base + 40_000),
  });
  const after = await buildModelMessages(ctx.db, tenant, row.id);
  expect(after.some((message) => message.role === "user" && message.content === goal)).toBe(true);
  expect(after.some((message) => message.role === "user" && message.content === correction)).toBe(
    true,
  );
  expect(after.filter((message) => message.content === goal)).toHaveLength(1);
});
