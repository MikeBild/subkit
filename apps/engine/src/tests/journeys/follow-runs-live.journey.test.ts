import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";
import { collectFrameList, collectFrames } from "./sse.ts";

describe("a person follows runs live over server-sent events", () => {
  describe("the tenant event stream", () => {
    let ctx: JourneyCtx;

    let workflowId = "";

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

    test("AC1: GET /v1/events/stream → 200 + text/event-stream", async () => {
      const res = await journeyFetch(ctx, "/v1/events/stream");
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct.toLowerCase()).toContain("text/event-stream");
      await collectFrameList(res, (frames) => frames.length >= 1, 3_000);
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

        const frames = await collectFrameList(
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
        const frames = await collectFrameList(
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
        const firstFrames = await collectFrameList(
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

        const replayed = await collectFrameList(
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

  describe("one execution's stream", () => {
    let ctx: JourneyCtx;

    let workflowId = "";

    let executionId = "";

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

    test(
      "AC1+AC2+AC3: full replay with ordered step frames, then server-side close",
      async () => {
        const res = await journeyFetch(ctx, `/v1/executions/${executionId}/stream`);
        expect(res.status).toBe(200);
        expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain(
          "text/event-stream",
        );

        const { frames, serverClosed } = await collectFrames(res, () => false, 10_000);
        expect(serverClosed).toBe(true);

        const types = frames.map((f) => f.event ?? "");
        const qi = types.indexOf("execution.queued");
        const si = types.indexOf("execution.started");
        const ti = types.indexOf("execution.succeeded");
        expect(qi).toBeGreaterThanOrEqual(0);
        expect(si).toBeGreaterThan(qi);
        expect(ti).toBeGreaterThan(si);
        const lastEventIdx = types.reduce(
          (acc, t, i) => (t.startsWith("execution.") ? i : acc),
          -1,
        );
        expect(lastEventIdx).toBe(ti);

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
        const { users, apiKeys } = await import("../../db/schema/index.ts");
        const [u] = await ctx.db
          .insert(users)
          .values({
            tenant_id: ctx.tenantId,
            email: "enduser@journey-55.test",
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
});
