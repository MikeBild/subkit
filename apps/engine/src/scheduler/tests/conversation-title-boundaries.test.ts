import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  buildTitlePrompt,
  deriveConversationTitle,
  isConversationTitleOpening,
  readConversationTitleRequests,
} from "../../conversations/title.ts";
import {
  conversationMessages,
  conversations,
  dataMigrations,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import { tenantWorkSnapshot } from "../../execution/tenant-work.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import {
  CONVERSATION_TITLE_SWEEP_NAME,
  resetConversationTitleSweep,
  runConversationTitleSweep,
} from "../conversation-title-runner.ts";

const nextUuid = createDeterministicUuidFactory(0x7171e);
let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("title_read_boundaries");
}, TEST_DB_HOOK_TIMEOUT);
beforeEach(async () => {
  await ctx.db.delete(conversations);
  await ctx.db.delete(dataMigrations).where(eq(dataMigrations.name, CONVERSATION_TITLE_SWEEP_NAME));
  resetConversationTitleSweep();
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

async function tenant() {
  const id = nextUuid();
  await ctx.db.insert(tenants).values({ id, slug: id, display_name: "Title boundary fixture" });
  return id;
}

async function conversation(
  tenantId: string,
  content: unknown,
  title = deriveConversationTitle(content) ?? "Untitled",
) {
  const id = nextUuid();
  await ctx.db.insert(conversations).values({ id, tenant_id: tenantId, status: "active", title });
  await addMessage(tenantId, id, content);
  return id;
}

async function addMessage(tenantId: string, conversationId: string, content: unknown, age = 0) {
  await ctx.db.insert(conversationMessages).values({
    id: nextUuid(),
    tenant_id: tenantId,
    conversation_id: conversationId,
    role: "user",
    content,
    created_at: new Date(getTestNow() + age),
  });
}

test("long string, text and summary openings preserve exact eligibility with bounded prompt sources", async () => {
  const tenantId = await tenant();
  const long = `\ufeff  Build\u00a0 the [file:fid_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa] report\n ${"details ".repeat(30_000)}  `;
  for (const content of [long, { text: long }, { text: " \t", summary: long }]) {
    const id = await conversation(tenantId, content);
    expect(await isConversationTitleOpening(ctx.db, tenantId, id)).toBe(true);
    const requests = await readConversationTitleRequests(ctx.db, tenantId, id);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.length).toBeLessThanOrEqual(300);
    expect(buildTitlePrompt(requests)).toBe(
      buildTitlePrompt([long.trim().replace(/\[file:fid_[0-9a-f-]+\]/g, "[file]")]),
    );
    await ctx.db
      .update(conversations)
      .set({ title: "Human authored title" })
      .where(eq(conversations.id, id));
    expect(await isConversationTitleOpening(ctx.db, tenantId, id)).toBe(false);
  }
});

test("old clips use JavaScript UTF16 and whitespace semantics for large emoji messages", async () => {
  const tenantId = await tenant();
  const opening = `Review ${"🎵 ".repeat(20)} then ${"details ".repeat(20_000)}`;
  const oldClip = `${opening.slice(0, 49).trimEnd()}…`;
  const id = await conversation(tenantId, opening, oldClip);
  expect(await isConversationTitleOpening(ctx.db, tenantId, id)).toBe(true);
});

test("the actual earliest user is authoritative and later matching messages are not substituted", async () => {
  const tenantId = await tenant();
  const id = await conversation(tenantId, "Original first request", "Later matching request");
  await addMessage(tenantId, id, "Later matching request", 1);
  expect(await isConversationTitleOpening(ctx.db, tenantId, id)).toBe(false);
  await ctx.db
    .update(conversations)
    .set({ title: "Original first request", title_locked: true })
    .where(eq(conversations.id, id));
  expect(await isConversationTitleOpening(ctx.db, tenantId, id)).toBe(false);
});

test("small generic JSON preserves fallback while oversized fallback never selects a later row", async () => {
  const tenantId = await tenant();
  const small = { nested: ["Review", "report"], flag: true };
  const smallId = await conversation(tenantId, small);
  const [stored] = await ctx.db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversation_id, smallId));
  const storedTitle = deriveConversationTitle(stored?.content);
  await ctx.db
    .update(conversations)
    .set({ title: storedTitle })
    .where(eq(conversations.id, smallId));
  expect(await isConversationTitleOpening(ctx.db, tenantId, smallId)).toBe(true);
  expect(await readConversationTitleRequests(ctx.db, tenantId, smallId)).toEqual([
    JSON.stringify(stored?.content),
  ]);
  const huge = { nested: ["unprojectable ".repeat(10_000)] };
  const id = await conversation(tenantId, huge, "Later request");
  await addMessage(tenantId, id, "Later request", 1);
  expect(await isConversationTitleOpening(ctx.db, tenantId, id)).toBe(false);
  expect(await readConversationTitleRequests(ctx.db, tenantId, id)).toEqual([]);
});

test("only the first three user requests reach the bounded shared title source", async () => {
  const tenantId = await tenant();
  const first = "🎵".repeat(20_000);
  const id = await conversation(tenantId, first);
  await addMessage(tenantId, id, { kind: "confirmation_decision", text: "not a request" }, 1);
  await addMessage(tenantId, id, { summary: "third ".repeat(20_000) }, 2);
  await addMessage(tenantId, id, "fourth-request-canary", 3);
  const requests = await readConversationTitleRequests(ctx.db, tenantId, id);
  expect(requests).toEqual([first.slice(0, 300), "third ".repeat(50)]);
  expect(buildTitlePrompt(requests)).not.toContain("fourth-request-canary");
});

test("inactive and foreign tenant reads refuse before locked message content can be selected", async () => {
  const tenantId = await tenant();
  const foreign = await tenant();
  const id = await conversation(tenantId, "private-body-canary");
  expect(await isConversationTitleOpening(ctx.db, foreign, id)).toBe(false);
  expect(await readConversationTitleRequests(ctx.db, foreign, id)).toEqual([]);
  const status = await ctx.pool.connect();
  const bodies = await ctx.pool.connect();
  try {
    await status.query("BEGIN");
    await status.query("UPDATE subkit.tenants SET status='suspended' WHERE id=$1", [tenantId]);
    await bodies.query("BEGIN");
    await bodies.query("LOCK TABLE subkit.conversation_messages IN ACCESS EXCLUSIVE MODE");
    let settled = false;
    let failure: unknown;
    const pending = readConversationTitleRequests(ctx.db, tenantId, id).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        failure = error;
        settled = true;
      },
    );
    await waitFor(() => tenantWorkSnapshot(tenantId).in_flight > 0);
    expect(tenantWorkSnapshot(foreign).in_flight).toBe(0);
    await status.query("COMMIT");
    await waitFor(() => settled, { sleepMs: 5, tries: 400 });
    await pending;
    expect(failure).toMatchObject({ code: "tenant_unavailable" });
    expect(String(failure)).not.toContain("private-body-canary");
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(0);
  } finally {
    await status.query("ROLLBACK").catch(() => {});
    await bodies.query("ROLLBACK").catch(() => {});
    status.release();
    bodies.release();
  }
});

test("sweep keeps the actual injected refresh promise registered until it settles", async () => {
  const tenantId = await tenant();
  const neighbor = await tenant();
  await conversation(tenantId, "Prepare the supplier report");
  await conversation(neighbor, "Neighbor request", "Human neighbor title");
  let entered = false;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = runConversationTitleSweep(ctx.db, {
    refreshTitle: async (selectedTenant) => {
      expect(selectedTenant).toBe(tenantId);
      entered = true;
      await barrier;
      return null;
    },
  });
  try {
    await waitFor(() => entered, { sleepMs: 5, tries: 400 });
    expect(tenantWorkSnapshot(tenantId).in_flight).toBe(1);
    expect(tenantWorkSnapshot(neighbor).in_flight).toBe(0);
  } finally {
    release?.();
  }
  expect((await pending).retitled).toBe(0);
  expect(tenantWorkSnapshot(tenantId).in_flight).toBe(0);
});

test("metadata pages keep the hundred-row global bound and resume without dropping the remainder", async () => {
  const tenantId = await tenant();
  for (let index = 0; index < 105; index++)
    await conversation(tenantId, `Request ${index}`, "Human title");
  const first = await runConversationTitleSweep(ctx.db);
  const second = await runConversationTitleSweep(ctx.db);
  const third = await runConversationTitleSweep(ctx.db);
  expect(first.scanned).toBe(100);
  expect(second.scanned).toBe(5);
  expect(third.done).toBe(true);
  const [remaining] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(eq(conversations.tenant_id, tenantId));
  expect(remaining?.count).toBe(105);
});

test("earliest user tie breaks by ID independently of insertion order", async () => {
  const tenantId = await tenant();
  const id = nextUuid();
  await ctx.db
    .insert(conversations)
    .values({ id, tenant_id: tenantId, status: "active", title: "First by stable ID" });
  await ctx.db.insert(conversationMessages).values([
    {
      id: "00000000-0000-4000-8000-000000000022",
      tenant_id: tenantId,
      conversation_id: id,
      role: "user",
      content: { text: "Inserted earlier" },
      created_at: new Date(getTestNow()),
    },
    {
      id: "00000000-0000-4000-8000-000000000011",
      tenant_id: tenantId,
      conversation_id: id,
      role: "user",
      content: { text: "First by stable ID" },
      created_at: new Date(getTestNow()),
    },
  ]);
  expect(await isConversationTitleOpening(ctx.db, tenantId, id)).toBe(true);
  expect((await readConversationTitleRequests(ctx.db, tenantId, id))[0]).toBe("First by stable ID");
});

test("SQL opening normalization matches JavaScript whitespace and empty messages remain ineligible", async () => {
  const tenantId = await tenant();
  const whitespace =
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  const id = await conversation(tenantId, `${whitespace}Review${whitespace}report${whitespace}`);
  expect(await isConversationTitleOpening(ctx.db, tenantId, id)).toBe(true);
  const empty = await conversation(tenantId, whitespace, "");
  expect(await isConversationTitleOpening(ctx.db, tenantId, empty)).toBe(false);
  expect(await readConversationTitleRequests(ctx.db, tenantId, empty)).toEqual([]);
});

test("the ten-attempt budget is global across tenant boundaries and deferred candidates resume", async () => {
  const firstTenant = await tenant();
  const secondTenant = await tenant();
  for (let index = 0; index < 11; index++)
    await conversation(index % 2 ? firstTenant : secondTenant, `Review monthly report ${index}`);
  const visited = new Set<string>();
  const refreshTitle = async (_tenantId: string, id: string) => {
    expect(visited.has(id)).toBe(false);
    visited.add(id);
    return null;
  };
  await runConversationTitleSweep(ctx.db, { refreshTitle });
  expect(visited.size).toBe(10);
  await runConversationTitleSweep(ctx.db, { refreshTitle });
  expect(visited.size).toBe(11);
});
