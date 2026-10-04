import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(count).toBe(1);
  });

  test("AC2: a follow-up turn without memory reuses the persisted row", async () => {
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
    const res = await journeyFetch(ctx, `/v1/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: "turn 2" }),
    });
    expect(res.status).toBe(200);
    const finalCount = await memoryAuditCount(id);
    expect(finalCount).toBe(initialCount);
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
