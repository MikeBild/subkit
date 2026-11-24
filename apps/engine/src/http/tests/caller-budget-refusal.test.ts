import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { refusalFromError } from "../../execution/use-cases/core/run-workflow.ts";
import { mapKnownErrorResponse } from "../middleware/error.ts";
import type { AppEnv } from "../openapi.ts";
import { refusalResponse } from "../routes/executions/run.ts";

const principal = {
  kind: "user",
  id: "00000000-0000-4000-8000-000000000001",
  tenant_id: "00000000-0000-4000-8000-000000000002",
  roles: ["admin"],
  provider: "api_key",
} as unknown as ResolvedPrincipal;

const dailyLimitReached = (resetsAt: string) =>
  Object.assign(new Error("the daily limit is reached"), {
    code: "rate_limited",
    details: {
      usage: { usedToday: 1, dailyLimit: 1, day: resetsAt.slice(0, 10), resetsAt },
    },
  });

async function answer(thrown: unknown): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => mapKnownErrorResponse(c, err) ?? c.json({ code: "internal_error" }, 500));
  app.post("/v1/executions", (c) => {
    const refusal = refusalFromError(thrown, "admission");
    if (!refusal) throw thrown;
    return refusalResponse(c, refusal, principal);
  });
  return app.request("/v1/executions", { method: "POST" });
}

test("a used-up daily limit answers 429 with a Retry-After until the reset", async () => {
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  expect(refusalFromError(dailyLimitReached(resetsAt), "admission")?.refusal).toBe("budget");
  const res = await answer(dailyLimitReached(resetsAt));
  expect(res.status).toBe(429);
  const retryAfter = Number(res.headers.get("Retry-After"));
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(3500);
  expect(retryAfter).toBeLessThanOrEqual(3600);
  expect(await res.json()).toMatchObject({
    error: "rate-limited",
    code: "rate_limited",
    usage: { usedToday: 1, dailyLimit: 1 },
    retry_after: retryAfter,
  });
});

test("a reset time already passed still asks the caller to wait at least one second", async () => {
  const res = await answer(dailyLimitReached(new Date(Date.now() - 5_000).toISOString()));
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("1");
});

test("a turn limit has no reset time and answers without Retry-After", async () => {
  const res = await answer(
    Object.assign(new Error("the turn used all of its calls"), { code: "turn_limit" }),
  );
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBeNull();
});
