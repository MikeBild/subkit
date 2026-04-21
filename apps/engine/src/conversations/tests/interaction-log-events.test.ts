// Interaction-log events — unit tests on the shape the service wires
// through recordTransition when an elicitation resolves. We skip the
// full runLoop round-trip (which would require live mock-provider
// plans) and instead assert the primitive contract every caller
// composes from.
//
// The service.ts integration is exercised in the acceptance e2e (Block L).
// Here we want a deterministic, fast proof that:
//
//   - The four user_* transitions each write the expected log entry shape.
//   - interaction_log is append-only: multiple transitions stack in order.
//   - recordTransition idempotency: same state logged twice → two entries
//     (not deduped); the column is a log, not a set.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  conversationMessages,
  conversations,
  conversationToolCalls,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { recordTransition } from "../confirmation.ts";

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("interaction_log_events");
  const [t] = await ctx.db.insert(tenants).values({ slug: "t-il", display_name: "T" }).returning();
  tenant_id = t!.id;
  const [c] = await ctx.db
    .insert(conversations)
    .values({
      tenant_id,
      status: "active",
    })
    .returning();
  conversation_id = c!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedToolCall(tool: string): Promise<string> {
  const [row] = await ctx.db
    .insert(conversationToolCalls)
    .values({
      tenant_id,
      conversation_id,
      tool,
      input: { kind: "commit_draft" },
    })
    .returning();
  return row!.id;
}

async function readLog(tool_call_id: string): Promise<Array<Record<string, unknown>>> {
  const [row] = await ctx.db
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.id, tool_call_id))
    .limit(1);
  return (row?.interaction_log ?? []) as Array<Record<string, unknown>>;
}

describe("recordTransition — one entry per user_* state", () => {
  test("user_confirmed", async () => {
    const id = await seedToolCall("ask_user_confirm");
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      to_state: "confirmed",
      tool: "ask_user_confirm",
    });
    const log = await readLog(id);
    expect(log).toHaveLength(1);
    expect(log[0]!.type).toBe("user_confirmed");
    expect(typeof log[0]!.ts).toBe("string");
    // also persists confirmation_state on the row
    const [row] = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.id, id));
    expect(row!.confirmation_state).toBe("confirmed");
  });

  test("user_declined", async () => {
    const id = await seedToolCall("ask_user_confirm");
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      to_state: "declined",
      tool: "ask_user_confirm",
    });
    const log = await readLog(id);
    expect(log[0]!.type).toBe("user_declined");
  });

  test("user_tested keeps the state flag as tested", async () => {
    const id = await seedToolCall("ask_user_confirm");
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      to_state: "tested",
      tool: "ask_user_confirm",
    });
    const [row] = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.id, id));
    expect(row!.confirmation_state).toBe("tested");
    const log = (row!.interaction_log ?? []) as Array<Record<string, unknown>>;
    expect(log[0]!.type).toBe("user_tested");
  });

  test("user_partial with data carries meta payload", async () => {
    const id = await seedToolCall("ask_user_confirm");
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      to_state: "partial",
      tool: "ask_user_confirm",
      data: { selected: ["a", "b"] },
      actor_id: "00000000-0000-0000-0000-000000000001",
    });
    const log = await readLog(id);
    expect(log[0]!.type).toBe("user_partial");
    const meta = log[0]!.meta as Record<string, unknown>;
    expect(meta.selected).toEqual(["a", "b"]);
    expect(meta.actor_id).toBe("00000000-0000-0000-0000-000000000001");
  });

  test("user_auto_declined (used by appendUserMessage supersede path)", async () => {
    const id = await seedToolCall("ask_user_confirm");
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      to_state: "auto_declined",
      tool: "ask_user_confirm",
    });
    const log = await readLog(id);
    expect(log[0]!.type).toBe("user_auto_declined");
  });
});

describe("interaction_log — append-only semantics", () => {
  test("two transitions stack in chronological order", async () => {
    const id = await seedToolCall("ask_user_confirm");
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      to_state: "tested",
      tool: "ask_user_confirm",
    });
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      to_state: "confirmed",
      tool: "ask_user_confirm",
    });
    const log = await readLog(id);
    expect(log).toHaveLength(2);
    expect(log[0]!.type).toBe("user_tested");
    expect(log[1]!.type).toBe("user_confirmed");
  });

  test("repeating the same transition appends a second entry (log, not set)", async () => {
    const id = await seedToolCall("ask_user_confirm");
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      to_state: "confirmed",
      tool: "ask_user_confirm",
    });
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      to_state: "confirmed",
      tool: "ask_user_confirm",
    });
    const log = await readLog(id);
    expect(log).toHaveLength(2);
    expect(log.every((e) => e.type === "user_confirmed")).toBe(true);
  });
});

describe("recordTransition — visible transcript message", () => {
  // Without this, the user's dialog Approve/Reject click is only
  // recorded in interaction_log metadata — invisible to the scrollback.
  // Passing conversation_id opts in to a user-visible marker message.

  async function readDecisionMessages(cid: string): Promise<Array<Record<string, unknown>>> {
    const rows = await ctx.db
      .select()
      .from(conversationMessages)
      .where(
        and(eq(conversationMessages.conversation_id, cid), eq(conversationMessages.role, "user")),
      );
    return rows
      .map((r) => r.content as Record<string, unknown>)
      .filter((c) => c?.kind === "confirmation_decision");
  }

  test("inserts a user-role message when conversation_id is supplied and state is confirmed", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    const cid = conv!.id;
    const id = await seedToolCall("create_api_key");
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      conversation_id: cid,
      to_state: "confirmed",
      tool: "create_api_key",
    });

    const msgs = await readDecisionMessages(cid);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe("✓ Approved: create_api_key");
    expect(msgs[0]!.to_state).toBe("confirmed");
    expect(msgs[0]!.tool).toBe("create_api_key");
  });

  test("emits a declined marker on declined transitions", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    const cid = conv!.id;
    const id = await seedToolCall("create_api_key");
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      conversation_id: cid,
      to_state: "declined",
      tool: "create_api_key",
    });

    const msgs = await readDecisionMessages(cid);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe("✗ Declined: create_api_key");
  });

  test("does NOT insert a visible message when conversation_id is omitted (test path)", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    const cid = conv!.id;
    const id = await seedToolCall("create_api_key");
    // No conversation_id passed — mirrors the test setup path.
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      to_state: "confirmed",
      tool: "create_api_key",
    });
    const msgs = await readDecisionMessages(cid);
    expect(msgs).toEqual([]);
  });

  test("skips the transcript marker for intermediate states (tested, proposed)", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    const cid = conv!.id;
    const id = await seedToolCall("create_api_key");
    await recordTransition(ctx.db, {
      tool_call_id: id,
      tenant_id,
      conversation_id: cid,
      to_state: "tested",
      tool: "create_api_key",
    });
    const msgs = await readDecisionMessages(cid);
    expect(msgs).toEqual([]);
  });
});

describe("service-layer wiring — code review", () => {
  test("respondElicitation mirrors output to recordTransition (source inspection)", async () => {
    // This is a best-effort static inspection: we assert the substring
    // pattern in service.ts so future refactors that drop the wiring
    // fail loudly rather than silently passing the unit tests above.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../service.ts", import.meta.url), "utf8");
    // Must import recordTransition:
    expect(src.includes('import("./confirmation.ts")')).toBe(true);
    expect(src.includes("recordTransition")).toBe(true);
    // Must handle the four primary outcomes:
    for (const state of ["confirmed", "declined", "partial", "tested", "auto_declined"]) {
      expect(src.includes(state)).toBe(true);
    }
  });
});
