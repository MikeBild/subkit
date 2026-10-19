import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { chatEventsSeen, chatWorkspaces, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  CHAT_DEDUP_CLEANUP_BATCH_SIZE,
  runChatDedupCleanup,
} from "../chat-dedup-cleanup-runner.ts";

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb("chat_dedup_bounded");
});
afterAll(async () => {
  await ctx?.cleanup();
});

test("one sweep deletes a bounded batch and leaves fresh replay protection intact", async () => {
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "dedup", display_name: "Dedup" })
    .returning();
  if (!tenant) throw new Error("missing tenant");
  const [workspace] = await ctx.db
    .insert(chatWorkspaces)
    .values({
      tenant_id: tenant.id,
      platform: "google_chat",
      workspace_id: "test-space",
      bot_ciphertext: Buffer.alloc(16),
      bot_iv: Buffer.alloc(12),
      bot_auth_tag: Buffer.alloc(16),
    })
    .returning();
  if (!workspace) throw new Error("missing workspace");
  const tick = new Date("2026-04-03T00:00:00Z");
  await ctx.db.insert(chatEventsSeen).values(
    Array.from({ length: CHAT_DEDUP_CLEANUP_BATCH_SIZE + 1 }, (_, index) => ({
      tenant_id: tenant.id,
      workspace_id: workspace.id,
      platform_event_id: `old-${index}`,
      seen_at: new Date("2026-04-01T00:00:00Z"),
    })),
  );
  await ctx.db.insert(chatEventsSeen).values({
    tenant_id: tenant.id,
    workspace_id: workspace.id,
    platform_event_id: "fresh",
    seen_at: tick,
  });
  await runChatDedupCleanup(tick, ctx.db);
  const remaining = await ctx.db
    .select()
    .from(chatEventsSeen)
    .where(eq(chatEventsSeen.tenant_id, tenant.id));
  expect(remaining).toHaveLength(2);
  expect(remaining.some((row) => row.platform_event_id === "fresh")).toBe(true);
  await runChatDedupCleanup(tick, ctx.db);
  const final = await ctx.db
    .select()
    .from(chatEventsSeen)
    .where(eq(chatEventsSeen.tenant_id, tenant.id));
  expect(final.map((row) => row.platform_event_id)).toEqual(["fresh"]);
});
