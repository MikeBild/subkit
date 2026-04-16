// User story: As a REPL user reviewing a pending commit, I need
// the SSE `approval_request` frame to carry the structured `diff`
// payload the approval tool emitted, so the CLI can render a
// kind-specific approval body (draft diff, external-write target,
// etc.) instead of a bare summary string.
//
// Acceptance criteria:
//
//   AC1. When `request_human_approval` is called with a structured
//        `diff` argument, the `approval_requests.diff` row is
//        persisted.
//   AC2. When the SSE stream is re-opened on the same conversation,
//        the `approval_request` frame for any still-pending row
//        includes the persisted `diff` field verbatim.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApprovalRequest } from "../../conversations/approval.ts";
import * as conversationsSvc from "../../conversations/service.ts";
import { approvalRequests } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

describe("journey: sk-cli approval diff surfacing", () => {
  let conversationId = "";
  let approvalId = "";

  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-07-approval-diff");
    // Create a conversation owned by the admin journey user so we
    // can drive the approval tool directly against it.
    const outcome = await conversationsSvc.createConversation(
      {
        tenant_id: ctx.tenantId,
        actor_id: ctx.userId,
      },
      ctx.db,
    );
    conversationId = outcome.conversation.id;

    // Persist a structured draft diff directly via the approval
    // helper. This simulates what `request_human_approval` does
    // when it runs as a tool step.
    const approval = await createApprovalRequest(
      {
        tenant_id: ctx.tenantId,
        conversation_id: conversationId,
        tool_call_id: null,
        kind: "commit_draft",
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
        actor_id: ctx.userId,
      },
      ctx.db,
    );
    approvalId = approval.id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  test("AC1: approval row persists the structured diff", async () => {
    const [row] = await ctx.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId))
      .limit(1);
    expect(row).toBeDefined();
    const diff = row?.diff as { name?: string; steps?: unknown[] } | null;
    expect(diff?.name).toBe("invoice-digest");
    expect(Array.isArray(diff?.steps)).toBe(true);
    expect(diff?.steps?.length).toBe(2);
  });

  test("AC2: SSE stream replays the approval_request frame with diff", async () => {
    const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/stream`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();

    // Parse out the first `approval_request` frame. We only need to
    // confirm that the `diff` payload round-tripped — the rest of
    // the frame shape is covered by existing conversation tests.
    const frames = text.split("\n\n").filter((chunk) => chunk.includes("event: approval_request"));
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const dataLine = (frames[0] ?? "").split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse((dataLine ?? "data: {}").slice(6)) as {
      approval_id: string;
      kind: string;
      diff?: { name?: string; steps?: unknown[] };
    };
    expect(payload.approval_id).toBe(approvalId);
    expect(payload.kind).toBe("commit_draft");
    expect(payload.diff?.name).toBe("invoice-digest");
    expect(payload.diff?.steps?.length).toBe(2);
  });
});
