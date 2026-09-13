// User story: As an operator (or end user) who just kicked off a
// workflow run, I want to follow that single execution live — step by
// step — without holding the tenant-wide `audit:read` compliance
// permission the unified /v1/events/stream tail requires.
// Acceptance criteria:
//   - AC1: GET /v1/executions/{id}/stream returns text/event-stream and
//          replays the run's full history: execution.queued →
//          execution.started → step frames → execution.succeeded.
//   - AC2: step frames carry step_key / step_index / kind / status and
//          arrive between execution.started and the terminal frame
//          (execution.step.started before execution.step.finished).
//   - AC3: the stream closes on its own right after the terminal frame
//          (a follower of a finished run does not hang).
//   - AC4: an enduser (execution:read, no audit:read) can follow the
//          run but is refused on /v1/events/stream.
//   - AC5: unknown execution id yields 404.
// Spec refs: docs/concepts/workflows.md ("Following a run live")

import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let workflowId = "";
let executionId = "";

interface SSEFrame {
  id?: string;
  event?: string;
  data?: string;
}

/** Read SSE frames until the stream ends, `until(frames)` is true, or
 *  the timeout elapses. Returns the frames plus whether the SERVER
 *  closed the stream (reader hit done) — AC3 asserts on that. */
async function collectFrames(
  res: Response,
  until: (frames: SSEFrame[]) => boolean,
  timeoutMs: number = 10_000,
): Promise<{ frames: SSEFrame[]; serverClosed: boolean }> {
  if (!res.body) throw new Error("SSE response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: SSEFrame[] = [];
  let buffer = "";
  let serverClosed = false;
  // allow-wall-clock: this test exercises real-time streaming deadlines.
  const deadline = Date.now() + timeoutMs;
  try {
    // allow-wall-clock: bounded read loop against a live SSE stream.
    while (Date.now() < deadline) {
      if (until(frames)) break;
      const timer = new Promise<{ done: true; value: undefined }>(
        (resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now() + 50), // allow-wall-clock: hard SSE read timeout
      );
      const chunk = (await Promise.race([reader.read(), timer])) as {
        done?: boolean;
        value?: Uint8Array;
      };
      if (!chunk || chunk.done || !chunk.value) {
        serverClosed = Boolean(chunk?.done && chunk.value === undefined);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const frame: SSEFrame = {};
        for (const line of raw.split("\n")) {
          if (line.startsWith("id:")) frame.id = line.slice(3).trim();
          else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
          else if (line.startsWith("data:")) frame.data = line.slice(5).trim();
        }
        if (frame.id || frame.event || frame.data) frames.push(frame);
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return { frames, serverClosed };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("execution-stream-follow");
  const wf = await seedWorkflow(ctx, {
    slug: "follow-wf",
    name: "Follow Wf",
    steps: [
      { kind: "transform", id: "first", expression: `"one"` },
      { kind: "transform", id: "second", expression: `"two"` },
    ],
  });
  workflowId = wf.id;

  // Run once synchronously — by the time this resolves every event
  // (queued, started, 2× step pairs, succeeded) is on the outbox.
  const run = await journeyFetch(ctx, "/v1/executions", {
    method: "POST",
    body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: {} }),
  });
  if (run.status !== 200 && run.status !== 202) {
    throw new Error(`seed run failed: ${run.status} ${await run.text()}`);
  }
  const body = (await run.json()) as { execution_id?: string };
  executionId = body.execution_id ?? "";
  if (!executionId) throw new Error("seed run returned no execution_id");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 55: per-execution SSE follow", () => {
  test(
    "AC1+AC2+AC3: full replay with ordered step frames, then server-side close",
    async () => {
      const res = await journeyFetch(ctx, `/v1/executions/${executionId}/stream`);
      expect(res.status).toBe(200);
      expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("text/event-stream");

      // Read until the server closes — the terminal frame ends the
      // stream, so `until` never fires and serverClosed flips true.
      const { frames, serverClosed } = await collectFrames(res, () => false, 10_000);
      expect(serverClosed).toBe(true);

      const types = frames.map((f) => f.event ?? "");
      const qi = types.indexOf("execution.queued");
      const si = types.indexOf("execution.started");
      const ti = types.indexOf("execution.succeeded");
      expect(qi).toBeGreaterThanOrEqual(0);
      expect(si).toBeGreaterThan(qi);
      expect(ti).toBeGreaterThan(si);
      // The terminal frame is the last event frame the server wrote.
      const lastEventIdx = types.reduce((acc, t, i) => (t.startsWith("execution.") ? i : acc), -1);
      expect(lastEventIdx).toBe(ti);

      // Step frames: one started + one finished per step, ordered, with
      // the documented payload fields.
      const stepStarted = frames.filter((f) => f.event === "execution.step.started");
      const stepFinished = frames.filter((f) => f.event === "execution.step.finished");
      expect(stepStarted.length).toBe(2);
      expect(stepFinished.length).toBe(2);
      for (const f of [...stepStarted, ...stepFinished]) {
        const payload = JSON.parse(f.data ?? "{}") as Record<string, unknown>;
        expect(payload.execution_id).toBe(executionId);
        expect(typeof payload.step_key).toBe("string");
        expect(typeof payload.step_index).toBe("number");
        expect(typeof payload.kind).toBe("string");
        expect(typeof payload.status).toBe("string");
      }
      const firstStartedIdx = types.indexOf("execution.step.started");
      const firstFinishedIdx = types.indexOf("execution.step.finished");
      expect(firstStartedIdx).toBeGreaterThan(si);
      expect(firstFinishedIdx).toBeGreaterThan(firstStartedIdx);
      expect(ti).toBeGreaterThan(firstFinishedIdx);
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test(
    "AC4: enduser follows the run but is refused on /v1/events/stream",
    async () => {
      // Seed an enduser + api key directly (same pattern as the
      // sk-cli-03 enduser dashboard journey). The enduser built-in role
      // grants execution:read but not audit:read.
      const { users, apiKeys } = await import("../../db/schema/index.ts");
      const [u] = await ctx.db
        .insert(users)
        .values({
          tenant_id: ctx.tenantId,
          email: "enduser@journey-55.test",
          role: "enduser",
          role_id: ctx.rbacRoleIds.enduser,
        })
        .returning();
      if (!u) throw new Error("failed to seed enduser");
      const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: api-key material
      const enduserKey = `wf_live_${rand}`;
      await ctx.db.insert(apiKeys).values({
        tenant_id: ctx.tenantId,
        user_id: u.id,
        prefix: enduserKey.slice(0, 12),
        token_sha256: createHash("sha256").update(enduserKey).digest("hex"),
        scopes: ["*"],
      });

      const enduserFetch = (path: string) =>
        fetch(`${ctx.baseUrl}${path}`, {
          headers: { authorization: `Bearer ${enduserKey}` },
        });

      const follow = await enduserFetch(`/v1/executions/${executionId}/stream`);
      expect(follow.status).toBe(200);
      // Drain so the poll loop frees up (terminal frame closes it).
      await collectFrames(follow, () => false, 10_000);

      const tenantWide = await enduserFetch("/v1/events/stream");
      expect(tenantWide.status).toBe(403);
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test("AC5: unknown execution id yields 404", async () => {
    const res = await journeyFetch(
      ctx,
      "/v1/executions/00000000-0000-0000-0000-000000000000/stream",
    );
    expect(res.status).toBe(404);
  });
});
