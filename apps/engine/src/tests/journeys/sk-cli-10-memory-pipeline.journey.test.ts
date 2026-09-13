// User story: As an admin, I drop a `SK.md` into my project
// root, run `sk -p "..."`, and the contents flow through the CLI's
// memory loader, land on `conversations.memory`, fire a
// `conversation.memory_injected` audit row, and persist across
// follow-up turns without me re-sending the payload.
//
// Acceptance criteria:
//
//   AC1. A project-level SK.md discovered by the memory loader
//        is forwarded on conversation create, written to
//        `conversations.memory`, and audited.
//   AC2. A follow-up turn without `memory` on the wire REUSES the
//        persisted row (no second `memory_injected` row is written).
//   AC3. Explicitly re-sending memory on a later turn writes a new
//        `memory_injected` row AND updates the row's memory column.
//   AC4. `sk --no-memory` skips injection even when SK.md exists.
//   AC5. The memory loader walks upward from a nested cwd and
//        picks up the closest SK.md.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import type { ResolvedProfile } from "../../../../sk/src/config.ts";
import { runHeadless } from "../../../../sk/src/headless.ts";
import { loadMemory } from "../../../../sk/src/memory.ts";
import { auditLog, conversations } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let tmpWorkspace: string;

const makeBuf = () => {
  const chunks: string[] = [];
  return {
    write: (s: string) => chunks.push(s),
    toString: () => chunks.join(""),
  };
};

function profile(): ResolvedProfile {
  return {
    name: "journey",
    engine_url: ctx.baseUrl,
    api_key: ctx.apiKey,
    active_tenant_id: ctx.tenantId,
  };
}

async function memoryAuditCount(conversationId: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "conversation.memory_injected"),
        eq(auditLog.resource_id, conversationId),
      ),
    );
  return rows.length;
}

async function conversationMemory(id: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ memory: conversations.memory })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  return row?.memory ?? null;
}

describe("journey: sk-cli memory pipeline", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-10-memory");
    tmpWorkspace = mkdtempSync(join(tmpdir(), "sk-memory-ws-"));
    writeFileSync(
      join(tmpWorkspace, "SK.md"),
      "# Project memory\n- prefer JSON response shapes\n- avoid pagination for list endpoints under 100 rows\n",
      "utf8",
    );
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    rmSync(tmpWorkspace, { recursive: true, force: true });
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  test("AC1: SK.md is forwarded, stored, and audited on first turn", async () => {
    const result = await runHeadless({
      profile: profile(),
      prompt: "create a sample workflow",
      output: "text",
      cwd: tmpWorkspace,
      stdout: makeBuf(),
      stderr: makeBuf(),
    });
    expect(result.exitCode).toBe(0);
    const id = result.conversation_id as string;
    expect(id).toBeDefined();
    const persisted = await conversationMemory(id);
    expect(persisted).toContain("prefer JSON response shapes");
    const count = await memoryAuditCount(id);
    // Create path emits exactly one memory_injected row when memory is
    // present.
    expect(count).toBe(1);
  });

  test("AC2: a follow-up turn without memory reuses the persisted row", async () => {
    // Create first.
    const created = await runHeadless({
      profile: profile(),
      prompt: "turn 1",
      output: "json",
      cwd: tmpWorkspace,
      stdout: makeBuf(),
      stderr: makeBuf(),
    });
    const id = created.conversation_id as string;
    const initialCount = await memoryAuditCount(id);
    // Second turn reattaches without resending memory.
    const res = await journeyFetch(ctx, `/v1/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: "turn 2" }),
    });
    expect(res.status).toBe(200);
    const finalCount = await memoryAuditCount(id);
    expect(finalCount).toBe(initialCount);
    // Persisted memory is still there.
    expect(await conversationMemory(id)).toContain("prefer JSON response shapes");
  });

  test("AC3: explicitly resending memory writes a new row", async () => {
    const created = await runHeadless({
      profile: profile(),
      prompt: "initial",
      output: "text",
      cwd: tmpWorkspace,
      stdout: makeBuf(),
      stderr: makeBuf(),
    });
    const id = created.conversation_id as string;
    const initialCount = await memoryAuditCount(id);
    const res = await journeyFetch(ctx, `/v1/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message: "with updated memory",
        memory: "# Updated memory\n- switched to RFC 7807 errors",
      }),
    });
    expect(res.status).toBe(200);
    expect(await memoryAuditCount(id)).toBe(initialCount + 1);
    const persisted = await conversationMemory(id);
    expect(persisted).toContain("RFC 7807");
  });

  test("AC4: --no-memory skips injection even when SK.md exists", async () => {
    const result = await runHeadless({
      profile: profile(),
      prompt: "no memory please",
      output: "text",
      noMemory: true,
      cwd: tmpWorkspace,
      stdout: makeBuf(),
      stderr: makeBuf(),
    });
    const id = result.conversation_id as string;
    expect(await memoryAuditCount(id)).toBe(0);
    expect(await conversationMemory(id)).toBeNull();
  });

  test("AC5: memory loader walks upward from a nested cwd", () => {
    const nested = join(tmpWorkspace, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const result = loadMemory({ cwd: nested });
    expect(result.content).toContain("prefer JSON response shapes");
    expect(result.sources[0]).toContain("SK.md");
  });
});
