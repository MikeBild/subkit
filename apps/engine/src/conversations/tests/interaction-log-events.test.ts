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
import { eq } from "drizzle-orm";
import {
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
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-il", display_name: "T" })
    .returning();
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

describe("service-layer wiring — code review", () => {
  test("respondElicitation mirrors output to recordTransition (source inspection)", async () => {
    // This is a best-effort static inspection: we assert the substring
    // pattern in service.ts so future refactors that drop the wiring
    // fail loudly rather than silently passing the unit tests above.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../service.ts", import.meta.url),
      "utf8",
    );
    // Must import recordTransition:
    expect(src.includes('import("./confirmation.ts")')).toBe(true);
    expect(src.includes("recordTransition")).toBe(true);
    // Must handle the four primary outcomes:
    for (const state of [
      "confirmed",
      "declined",
      "partial",
      "tested",
      "auto_declined",
    ]) {
      expect(src.includes(state)).toBe(true);
    }
  });
});
