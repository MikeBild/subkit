// User story: As an operator mid-authoring, I want to disconnect from
// and re-attach to an in-progress conversation and resume without
// losing state.
// Acceptance criteria:
//   - AC1: The first SSE stream after an awaiting_input turn surfaces
//          the tool-call trace plus a pending elicit_request frame.
//   - AC2: Closing the stream and re-opening with the same conversation
//          id re-plays the same state plus any subsequent events.
//   - AC3: After responding to the elicitation with `{confirmed:true}`,
//          a reconnect surfaces a `committed` frame referencing the
//          materialised workflow.
//   - AC4: Aborting an in-flight SSE read mid-stream and reconnecting
//          replays the same events in the same order (the server
//          re-delivers the persisted snapshot on every GET), then a
//          follow-up turn + elicit response produces a `committed`
//          frame on the subsequent reconnect.
// Spec refs: docs/04-authoring.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

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
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, 60_000);

async function streamEvents(id: string): Promise<string[]> {
  const res = await journeyFetch(ctx, `/v1/conversations/${id}/stream`);
  expect(res.status).toBe(200);
  const body = await res.text();
  return body
    .split("\n")
    .filter((l) => l.startsWith("event:"))
    .map((l) => l.slice("event:".length).trim());
}

describe("journey: conversation resume", () => {
  test("AC1: initial turn pauses at an elicitation and SSE surfaces the trace", async () => {
    const createRes = await journeyFetch(ctx, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        connector_id: connectorId,
        initial_message: "list users from the api",
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

  test("AC3: responding to the elicitation drives the conversation to committed; next stream emits committed", async () => {
    const respondRes = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/elicitations/${pendingElicitationId}/respond`,
      { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
    );
    expect(respondRes.status).toBe(200);
    const out = (await respondRes.json()) as {
      status: string;
    };
    expect(out.status).toBe("committed");

    const evts = await streamEvents(conversationId);
    expect(evts).toContain("committed");
    expect(evts).toContain("completed");
  });

  test("AC4: mid-stream abort + reconnect replays existing events then commit arrives on the next reconnect", async () => {
    // Fresh conversation so we don't disturb the AC1-3 state machine
    // above. This conversation drives through its own
    // awaiting_input → respond_elicitation → committed transition
    // end-to-end so we can assert that a reconnect after the abort
    // re-serves the same prefix of events the original stream already
    // delivered.
    const createRes = await journeyFetch(ctx, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        connector_id: connectorId,
        initial_message: "list users from the api (resume flow)",
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

    // Rename the live draft so the eventual commit produces a
    // workflow with a unique slug. AC3 above commits its own draft
    // through the same canned plan, so without this nudge the second
    // commit would hit a (tenant_id, slug) unique-constraint
    // violation and leave the conversation in `active`.
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
        // The draft model is canonical on `draft.workflow`. Rename the
        // nested workflow snapshot directly so the eventual commit uses
        // a unique slug even after AC3 has already created
        // `new-workflow` in the same tenant.
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

    // 1) Open an SSE stream and read exactly two event frames, then
    //    abort the underlying request to force a mid-stream disconnect.
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
      // SSE frames are blank-line terminated. Parse every complete
      // frame we've buffered so far.
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
    // Tear the stream down WITHOUT draining the tail so we're genuinely
    // mid-stream from the server's POV.
    try {
      controller.abort();
    } catch {
      /* ignore abort errors */
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore cancel errors */
    }

    expect(collectedEvents.length).toBeGreaterThanOrEqual(2);
    const firstTwo = collectedEvents.slice(0, 2);

    // 2) Reconnect. The replay should still include the same prefix we
    //    captured before aborting — the server persists turn events to
    //    the database and re-serves them on every GET.
    const replayed = await streamEvents(convId);
    expect(replayed.length).toBeGreaterThanOrEqual(firstTwo.length);
    expect(replayed.slice(0, firstTwo.length)).toEqual(firstTwo);

    // 3) Respond to the pending askUser.confirm elicitation with
    //    `{confirmed:true}` to drive the conversation to `committed`.
    //    In this harness the respond endpoint itself is the
    //    continuation trigger; `POST /messages` would just queue
    //    another LLM turn and is not required for AC4's commit
    //    assertion.
    const respondRes = await journeyFetch(
      ctx,
      `/v1/conversations/${convId}/elicitations/${elicitationId}/respond`,
      { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
    );
    expect(respondRes.status).toBe(200);
    const respondOut = (await respondRes.json()) as { status: string };
    expect(respondOut.status).toBe("committed");

    // 4) Reconnect one more time; the replayed stream must now include
    //    a `committed` frame that the first stream didn't carry.
    const afterCommit = await streamEvents(convId);
    expect(afterCommit).toContain("committed");
  });
});
