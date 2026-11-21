import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectors, conversations, workflows } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let connectorId = "";
let conversationId = "";
let pendingElicitationId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("conv-resume");
  const [row] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "api-resume",
      display_name: "API Resume",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://jsonplaceholder.typicode.com",
      config: {},
    })
    .returning();
  connectorId = row!.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

async function streamEvents(id: string): Promise<string[]> {
  const res = await journeyFetch(ctx, `/v1/conversations/${id}/stream`);
  expect(res.status).toBe(200);
  const body = await res.text();
  return body
    .split("\n")
    .filter((l) => l.startsWith("event:"))
    .map((l) => l.slice("event:".length).trim());
}

async function expectSavedDraft(id: string) {
  const [row] = await ctx.db
    .select({ draft: workflows.draft_version_id, active: workflows.current_version_id })
    .from(conversations)
    .innerJoin(
      workflows,
      and(
        eq(workflows.id, conversations.target_workflow_id),
        eq(workflows.tenant_id, ctx.tenantId),
      ),
    )
    .where(and(eq(conversations.id, id), eq(conversations.tenant_id, ctx.tenantId)));
  expect(row?.draft).toBeTruthy();
  expect(row?.active).toBeNull();
}

describe("conversation resume", () => {
  test("AC1: initial turn pauses at an elicitation and SSE surfaces the trace", async () => {
    const createRes = await journeyFetch(ctx, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        connector_id: connectorId,
        initial_message: "list users from the api",
        permission_mode: "ask",
      }),
    });
    expect(createRes.status).toBe(201);
    const out = (await createRes.json()) as {
      conversation: { id: string };
      pending_elicitation_id?: string;
      status: string;
    };
    expect(out.status).toBe("awaiting_input");
    conversationId = out.conversation.id;
    pendingElicitationId = out.pending_elicitation_id!;

    const evts = await streamEvents(conversationId);
    expect(evts).toContain("message");
    expect(evts).toContain("tool_call_start");
    expect(evts).toContain("tool_result");
    expect(evts).toContain("elicit_request");
  });

  test("AC2: reconnecting with the same conversation_id replays the snapshot", async () => {
    const evts = await streamEvents(conversationId);
    expect(evts).toContain("tool_call_start");
    expect(evts).toContain("elicit_request");
  });

  test("AC3: confirming saves an inert draft; reconnect does not claim activation", async () => {
    const respondRes = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/elicitations/${pendingElicitationId}/respond`,
      { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
    );
    expect(respondRes.status).toBe(200);
    const out = (await respondRes.json()) as {
      status: string;
    };
    expect(out.status).toBe("active");
    await expectSavedDraft(conversationId);

    const evts = await streamEvents(conversationId);
    expect(evts).not.toContain("committed");
    expect(evts).toContain("completed");
  });

  test("AC4: mid-stream abort and reconnect preserve events and the subsequently saved draft", async () => {
    const createRes = await journeyFetch(ctx, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        connector_id: connectorId,
        initial_message: "list users from the api (resume flow)",
        permission_mode: "ask",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      conversation: { id: string };
      pending_elicitation_id?: string;
      status: string;
    };
    expect(created.status).toBe("awaiting_input");
    const convId = created.conversation.id;
    const elicitationId = created.pending_elicitation_id!;

    {
      const { and, desc, eq } = await import("drizzle-orm");
      const { conversationDrafts } = await import("../../db/schema/index.ts");
      const rows = await ctx.db
        .select()
        .from(conversationDrafts)
        .where(
          and(
            eq(conversationDrafts.tenant_id, ctx.tenantId),
            eq(conversationDrafts.conversation_id, convId),
          ),
        )
        .orderBy(desc(conversationDrafts.ordinal))
        .limit(1);
      const top = rows[0];
      if (top) {
        const snap = top.snapshot as Record<string, unknown>;
        const workflow =
          snap.workflow && typeof snap.workflow === "object"
            ? { ...(snap.workflow as Record<string, unknown>) }
            : null;
        const renamed = {
          ...snap,
          name: "resume-flow-workflow",
          slug: "resume-flow-workflow",
          workflow: workflow
            ? {
                ...workflow,
                name: "resume-flow-workflow",
                slug: "resume-flow-workflow",
              }
            : workflow,
        };
        await ctx.db
          .update(conversationDrafts)
          .set({ snapshot: renamed as unknown as Record<string, unknown> })
          .where(eq(conversationDrafts.id, top.id));
      }
    }

    const controller = new AbortController();
    const firstRes = await fetch(`${ctx.baseUrl}/v1/conversations/${convId}/stream`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      signal: controller.signal,
    });
    expect(firstRes.status).toBe(200);
    expect(firstRes.body).not.toBeNull();

    const reader = firstRes.body!.getReader();
    const decoder = new TextDecoder();
    const collectedEvents: string[] = [];
    let buffer = "";
    readLoop: while (collectedEvents.length < 2) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let blankIdx = buffer.indexOf("\n\n");
      while (blankIdx !== -1) {
        const rawFrame = buffer.slice(0, blankIdx);
        buffer = buffer.slice(blankIdx + 2);
        for (const line of rawFrame.split("\n")) {
          if (line.startsWith("event:")) {
            collectedEvents.push(line.slice("event:".length).trim());
            if (collectedEvents.length >= 2) break readLoop;
          }
        }
        blankIdx = buffer.indexOf("\n\n");
      }
    }
    try {
      controller.abort();
    } catch {}
    try {
      await reader.cancel();
    } catch {}

    expect(collectedEvents.length).toBeGreaterThanOrEqual(2);
    const firstTwo = collectedEvents.slice(0, 2);

    const replayed = await streamEvents(convId);
    expect(replayed.length).toBeGreaterThanOrEqual(firstTwo.length);
    expect(replayed.slice(0, firstTwo.length)).toEqual(firstTwo);

    const respondRes = await journeyFetch(
      ctx,
      `/v1/conversations/${convId}/elicitations/${elicitationId}/respond`,
      { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
    );
    expect(respondRes.status).toBe(200);
    const respondOut = (await respondRes.json()) as { status: string };
    expect(respondOut.status).toBe("active");
    await expectSavedDraft(convId);

    const afterCommit = await streamEvents(convId);
    expect(afterCommit).not.toContain("committed");
    expect(afterCommit).toContain("completed");
  });
});
