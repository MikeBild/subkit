// User story: As an admin operator, I can drive a full conversation
// turn via `sk -p "..."` against the engine, see the assistant
// response, commit a workflow through an approval, and find every
// step of the session in the audit log.
//
// Acceptance criteria:
//
//   AC1. Given an empty tenant, when I call runHeadless with a
//        list-users prompt, then a CONVERSATION_CREATED audit row
//        exists attributed to my user id AND memory_included=false.
//   AC2. When I append a second message with a memory payload, then
//        a CONVERSATION_MEMORY_INJECTED audit row exists.
//   AC3. When I compact the conversation, then a CONVERSATION_COMPACTED
//        audit row exists and the response reports messages_collapsed.
//   AC4. When I PATCH the conversation with a new model + title, then
//        a CONVERSATION_UPDATED audit row exists and GET returns them.
//   AC5. When I list conversations with owner=me, the list contains
//        the conversation I just created (owner_id plumbing).
//   AC6. When I cancel the conversation, a CONVERSATION_CANCELLED row
//        exists and the status flips to 'abandoned'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runHeadless } from "../../../../sk/src/headless.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

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
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

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
      noMemory: true, // the working dir may pick up stray SUBKIT.md files
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
    expect((latest?.metadata as { owner_id?: string }).owner_id).toBe(ctx.userId);
    expect((latest?.metadata as { memory_included?: boolean }).memory_included).toBe(false);
  });

  test("AC2: memory injection emits CONVERSATION_MEMORY_INJECTED", async () => {
    // Under the post-rebuild contract the canned list-users plan ends
    // with `ask_user_confirm` before `commit_draft`, parking the
    // conversation in `awaiting_input`. Resolve that elicitation
    // (operator confirms) before posting a follow-up message;
    // `POST /v1/conversations/{id}/messages` returns 409
    // `pending_elicitation_blocked` while one is still open.
    const detail = (await (
      await journeyFetch(ctx, `/v1/conversations/${conversationId}`)
    ).json()) as {
      elicitations?: Array<{ id: string; status: string; tool_name: string }>;
    };
    const pending = (detail.elicitations ?? []).find((e) => e.status === "pending");
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
