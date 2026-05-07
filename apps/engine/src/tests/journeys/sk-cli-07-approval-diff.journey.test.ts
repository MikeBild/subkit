// User story: As a REPL user reviewing a pending commit, I need the
// SSE `elicit_request` frame to carry the structured `diff` payload
// the `ask_user_confirm` tool emitted, so the CLI can render a
// kind-specific confirm body (draft diff, external-write target,
// etc.) instead of a bare summary string.
//
// Acceptance criteria:
//
//   AC1. When an `ask_user_confirm` elicitation is created with a
//        structured `diff` payload, the
//        `conversation_elicitations.input` row is persisted and
//        contains the diff.
//   AC2. When the SSE stream is re-opened on the same conversation,
//        the `elicit_request` frame for any still-pending row
//        includes the persisted `diff` field verbatim.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createElicitation } from "../../conversations/elicitations.ts";
import * as conversationsSvc from "../../conversations/service.ts";
import { conversationElicitations } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

describe("journey: sk-cli elicitation diff surfacing", () => {
  let conversationId = "";
  let elicitationId = "";

  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-07-approval-diff");
    const outcome = await conversationsSvc.createConversation(
      {
        tenant_id: ctx.tenantId,
        actor_id: ctx.userId,
      },
      ctx.db,
    );
    conversationId = outcome.conversation.id;

    // Persist a structured save_workflow_draft confirm directly via the
    // elicitation helper — mirrors what `ask_user_confirm` does at
    // runtime without driving the full tool loop.
    const elicitation = await createElicitation(
      {
        tenant_id: ctx.tenantId,
        conversation_id: conversationId,
        tool_call_id: null,
        tool_name: "ask_user_confirm",
        summary: "commit 2-step workflow",
        input: {
          question: "Commit this workflow?",
          kind: "save_workflow_draft",
          summary: "commit 2-step workflow",
          diff: {
            name: "invoice-digest",
            slug: "invoice-digest",
            description: "Fetch overnight invoices and summarize",
            steps: [
              {
                id: "fetch",
                kind: "request",
                connector_id: "00000000-0000-0000-0000-000000000001",
                path: "/v1/invoices?since=yesterday",
              },
              { id: "summarize", kind: "transform", expression: "$.items" },
            ],
          },
        },
        actor_id: ctx.userId,
      },
      ctx.db,
    );
    elicitationId = elicitation.id;
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  test("AC1: elicitation row persists the structured diff", async () => {
    const [row] = await ctx.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitationId))
      .limit(1);
    expect(row).toBeDefined();
    const input = row?.input as { diff?: { name?: string; steps?: unknown[] } } | null;
    expect(input?.diff?.name).toBe("invoice-digest");
    expect(Array.isArray(input?.diff?.steps)).toBe(true);
    expect(input?.diff?.steps?.length).toBe(2);
  });

  test("AC2: SSE stream replays the elicit_request frame with diff", async () => {
    const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/stream`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();

    const frames = text.split("\n\n").filter((chunk) => chunk.includes("event: elicit_request"));
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const dataLine = (frames[0] ?? "").split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse((dataLine ?? "data: {}").slice(6)) as {
      elicitation_id: string;
      tool_name: string;
      input?: { kind?: string; diff?: { name?: string; steps?: unknown[] } };
    };
    expect(payload.elicitation_id).toBe(elicitationId);
    expect(payload.tool_name).toBe("ask_user_confirm");
    expect(payload.input?.kind).toBe("save_workflow_draft");
    expect(payload.input?.diff?.name).toBe("invoice-digest");
    expect(payload.input?.diff?.steps?.length).toBe(2);
  });
});
