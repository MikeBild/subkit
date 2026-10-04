import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runHeadless } from "../../../../sk/src/headless.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

interface AuditRow {
  action: string;
  actor_id: string | null;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
}

async function auditRows(opts: { action?: string; actor_id?: string }): Promise<AuditRow[]> {
  const query = new URLSearchParams();
  if (opts.action) query.set("action", opts.action);
  if (opts.actor_id) query.set("actor_id", opts.actor_id);
  query.set("limit", "50");
  const res = await journeyFetch(ctx, `/v1/audit-log?${query.toString()}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: AuditRow[] };
  return body.items;
}

describe("journey: sk-cli admin golden path", () => {
  let conversationId: string;

  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-01-admin");
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  test("AC1: runHeadless creates a conversation and emits CONVERSATION_CREATED", async () => {
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    const result = await runHeadless({
      profile: {
        name: "journey",
        engine_url: ctx.baseUrl,
        api_key: ctx.apiKey,
        active_tenant_id: ctx.tenantId,
      },
      prompt: "list users from the JSONPlaceholder connector",
      output: "json",
      noMemory: true,
      stdout: { write: (s) => stdoutBuf.push(s) },
      stderr: { write: (s) => stderrBuf.push(s) },
    });
    expect(result.exitCode).toBe(0);
    expect(result.conversation_id).not.toBeNull();
    conversationId = result.conversation_id as string;
    const rows = await auditRows({
      action: "conversation.created",
      actor_id: ctx.userId,
    });
    const latest = rows[0];
    expect(latest?.resource_id).toBe(conversationId);
    expect((latest!.metadata as { owner_id?: string }).owner_id).toBe(ctx.userId);
    expect((latest!.metadata as { memory_included?: boolean }).memory_included).toBe(false);
  });

  test("AC2: memory injection emits CONVERSATION_MEMORY_INJECTED", async () => {
    const detail = (await (
      await journeyFetch(ctx, `/v1/conversations/${conversationId}`)
    ).json()) as {
      resume_summary?: {
        pending_approval?: { id: string; tool_name: string } | null;
      } | null;
    };
    const pending = detail.resume_summary?.pending_approval ?? null;
    if (pending) {
      const resp = await journeyFetch(
        ctx,
        `/v1/conversations/${conversationId}/elicitations/${pending.id}/respond`,
        {
          method: "POST",
          body: JSON.stringify({ output: { confirmed: true } }),
        },
      );
      expect(resp.status).toBe(200);
    }

    const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message: "follow up turn",
        memory: "# Context\n- prefer JSON responses\n",
      }),
    });
    expect(res.status).toBe(200);
    const rows = await auditRows({
      action: "conversation.memory_injected",
      actor_id: ctx.userId,
    });
    expect(rows.some((r) => r.resource_id === conversationId)).toBe(true);
  });

  test("AC3: compact collapses history and emits CONVERSATION_COMPACTED", async () => {
    const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/compact`, {
      method: "POST",
      body: JSON.stringify({ keep_last: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages_collapsed: number; summary: string };
    expect(body.messages_collapsed).toBeGreaterThan(0);
    expect(typeof body.summary).toBe("string");
    const rows = await auditRows({ action: "conversation.compacted" });
    expect(rows.some((r) => r.resource_id === conversationId)).toBe(true);
  });

  test("AC4: PATCH stores model + title and emits CONVERSATION_UPDATED", async () => {
    const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify({
        model: "anthropic:claude-opus-4-6",
        title: "Admin golden path",
      }),
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as { model: string | null; title: string | null };
    expect(patched.model).toBe("anthropic:claude-opus-4-6");
    expect(patched.title).toBe("Admin golden path");
    const rows = await auditRows({ action: "conversation.updated" });
    expect(rows.some((r) => r.resource_id === conversationId)).toBe(true);
  });

  test("AC5: owner=me list returns my conversations", async () => {
    const res = await journeyFetch(ctx, "/v1/conversations?owner=me&limit=50");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; owner_id: string | null; title: string | null }>;
    };
    const mine = body.items.find((i) => i.id === conversationId);
    expect(mine).toBeDefined();
    expect(mine?.owner_id).toBe(ctx.userId);
    expect(mine?.title).toBe("Admin golden path");
  });

  test("AC6: cancel flips status to abandoned and emits CONVERSATION_CANCELLED", async () => {
    const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const cancelled = (await res.json()) as { status: string };
    expect(cancelled.status).toBe("abandoned");
    const rows = await auditRows({ action: "conversation.cancelled" });
    expect(rows.some((r) => r.resource_id === conversationId)).toBe(true);
  });
});
