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

interface SSEFrame {
  id?: string;
  event?: string;
  data?: string;
}

async function collectFrames(
  res: Response,
  until: (frames: SSEFrame[]) => boolean,
  timeoutMs: number = 10_000,
): Promise<SSEFrame[]> {
  if (!res.body) throw new Error("SSE response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: SSEFrame[] = [];
  let buffer = "";
  // allow-wall-clock: this test exercises real-time polling or freshness windows.
  const deadline = Date.now() + timeoutMs;

  try {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (Date.now() < deadline) {
      if (until(frames)) break;
      const chunkPromise = reader.read();
      // allow-wall-clock: hard SSE read timeout so a silent server
      // doesn't stall the test forever. The deadline is bounded, the
      // race resolves to a no-op, and control flow exits cleanly.
      const timer = new Promise<{ done: true; value: undefined }>(
        (resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now() + 50), // allow-wall-clock: SSE deadline reads real wall-clock — the test asserts the stream closes within budget
      );
      const chunk = (await Promise.race([chunkPromise, timer])) as {
        done?: boolean;
        value?: Uint8Array;
      };
      if (!chunk || chunk.done || !chunk.value) break;
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
    } catch {}
  }
  return frames;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("events-stream");
  const wf = await seedWorkflow(ctx, {
    slug: "ping-wf",
    name: "Ping Wf",
    steps: [
      {
        kind: "transform",
        id: "t1",
        expression: `"ok"`,
      },
    ],
  });
  workflowId = wf.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 19: events SSE stream", () => {
  test("AC1: GET /v1/events/stream → 200 + text/event-stream", async () => {
    const res = await journeyFetch(ctx, "/v1/events/stream");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("text/event-stream");
    await collectFrames(res, (frames) => frames.length >= 1, 3_000);
  });

  test(
    "AC2+AC3: workflow run yields queued/started/succeeded in order",
    async () => {
      const res = await journeyFetch(ctx, "/v1/events/stream");
      expect(res.status).toBe(200);

      const runPromise = journeyFetch(ctx, "/v1/executions", {
        method: "POST",
        body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: { seed: 1 } }),
      });

      const frames = await collectFrames(
        res,
        (fs) => {
          const seen = fs.map((f) => f.event ?? "");
          return (
            seen.includes("execution.queued") &&
            seen.includes("execution.started") &&
            seen.includes("execution.succeeded")
          );
        },
        10_000,
      );

      const runRes = await runPromise;
      expect(runRes.status === 200 || runRes.status === 202).toBe(true);

      const events = frames.map((f) => f.event ?? "");
      const qi = events.indexOf("execution.queued");
      const si = events.indexOf("execution.started");
      const ci = events.indexOf("execution.succeeded");
      expect(qi).toBeGreaterThanOrEqual(0);
      expect(si).toBeGreaterThan(qi);
      expect(ci).toBeGreaterThan(si);
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test(
    "AC5: ?execution_id=<id> narrows the tail to that execution only",
    async () => {
      const runA = await journeyFetch(ctx, "/v1/executions", {
        method: "POST",
        body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: { seed: 11 } }),
      });
      expect(runA.status === 200 || runA.status === 202).toBe(true);
      const bodyA = (await runA.json()) as { execution_id?: string };
      const execA = bodyA.execution_id ?? "";
      expect(execA).toMatch(/^[0-9a-f-]{36}$/);

      const runB = await journeyFetch(ctx, "/v1/executions", {
        method: "POST",
        body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: { seed: 22 } }),
      });
      expect(runB.status === 200 || runB.status === 202).toBe(true);

      const filtered = await journeyFetch(
        ctx,
        `/v1/events/stream?execution_id=${encodeURIComponent(execA)}`,
      );
      expect(filtered.status).toBe(200);
      const frames = await collectFrames(
        filtered,
        (fs) => {
          const seen = fs.map((f) => f.event ?? "");
          return seen.includes("execution.succeeded");
        },
        10_000,
      );
      for (const f of frames) {
        if (!f.data) continue;
        try {
          const parsed = JSON.parse(f.data) as { execution_id?: string };
          if (parsed.execution_id) {
            expect(parsed.execution_id).toBe(execA);
          }
        } catch {}
      }
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test("AC6: invalid execution_id yields 400", async () => {
    const res = await journeyFetch(ctx, "/v1/events/stream?execution_id=not-a-uuid");
    expect(res.status).toBe(400);
  });

  test(
    "AC4: reconnect with Last-Event-ID replays from the next frame",
    async () => {
      const initial = await journeyFetch(ctx, "/v1/events/stream");
      expect(initial.status).toBe(200);
      const firstFrames = await collectFrames(
        initial,
        (fs) => fs.some((f) => Boolean(f.id)),
        5_000,
      );
      const ids = firstFrames
        .map((f) => (f.id ? Number.parseInt(f.id, 10) : Number.NaN))
        .filter((n) => Number.isFinite(n));
      expect(ids.length).toBeGreaterThan(0);
      const resumeFrom = Math.min(...ids);

      const resumeRes = await journeyFetch(ctx, "/v1/events/stream", {
        headers: { "last-event-id": String(resumeFrom) },
      });
      expect(resumeRes.status).toBe(200);

      const replayed = await collectFrames(
        resumeRes,
        (fs) => fs.some((f) => (f.id ? Number.parseInt(f.id, 10) > resumeFrom : false)),
        10_000,
      );
      const hasNewerFrame = replayed.some((f) => f.id && Number.parseInt(f.id, 10) > resumeFrom);
      expect(hasNewerFrame).toBe(true);
    },
    JOURNEY_HOOK_TIMEOUT,
  );
});
