import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { sensitiveRunError } from "../../execution/sensitive-payload.ts";
import {
  CALLER_FORBIDDEN_CODES,
  refusalFromError,
} from "../../execution/use-cases/core/run-workflow.ts";
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

async function answer(thrown: unknown): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => mapKnownErrorResponse(c, err) ?? c.json({ code: "internal_error" }, 500));
  app.post("/v1/executions", (c) => {
    const refusal = refusalFromError(thrown, "execution", "00000000-0000-4000-8000-000000000003");
    if (!refusal) throw thrown;
    return refusalResponse(c, refusal, principal);
  });
  return app.request("/v1/executions", { method: "POST" });
}

test("a sensitive run that fails before its result answers 409, never an unhandled 500", async () => {
  const wrapped = sensitiveRunError(new Error("connection reset while reading the version"));
  expect(wrapped.message).toBe("Sensitive execution could not be resumed or run.");
  const res = await answer(wrapped);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    code: "sensitive_execution_failure",
    message: "Sensitive execution could not be resumed or run.",
    details: { execution_id: "00000000-0000-4000-8000-000000000003" },
  });
});

test("the sensitive wrapper keeps every refusal code a caller can act on", async () => {
  for (const code of [...CALLER_FORBIDDEN_CODES, "execution_authority_required"]) {
    const wrapped = sensitiveRunError(Object.assign(new Error("secret detail"), { code }));
    expect(wrapped.message).not.toContain("secret detail");
    const res = await answer(wrapped);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await res.json()).code).toBe(code);
  }
  const forbidden = await answer(
    sensitiveRunError(Object.assign(new Error("x"), { code: "caller_kind_mismatch" })),
  );
  expect(forbidden.status).toBe(403);
  const input = await answer(
    sensitiveRunError(Object.assign(new Error("x"), { code: "input_schema_violation" })),
  );
  expect(input.status).toBe(400);
});
