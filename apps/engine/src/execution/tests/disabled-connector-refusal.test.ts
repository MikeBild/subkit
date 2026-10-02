// A connector an operator switched off refuses the step under its own name.
//
// Why this suite exists: the request dispatcher looked at the circuit breaker
// but never at `enabled`. A workflow preview runs in dev, so a step that names
// the prod connector resolves to its same-slug dev twin — and when that twin
// was disabled, the preview either called it anyway or, once earlier failures
// had opened the twin's breaker, answered `circuit_open`. The reader was sent
// to look for an unreachable remote while the cause was a switch on our side.
//
// Contract under test:
//   1. Draft preview, disabled dev twin → `connector_disabled`, naming the
//      twin and its environment; nothing is sent, the breaker is not counted.
//   2. The same refusal wins over an open breaker on that twin.
//   3. The failed run reads `connector_unavailable` and names the twin.
//   4. Nothing falls back to the enabled connector the step names.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors, executions } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { classifyFailure } from "../classify.ts";
import { runExecution } from "../engine.ts";
import { deriveExecutionOutcome } from "../outcome.ts";
import {
  createEngineCtx,
  createMockServer,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let prodId: string;
let devTwinId: string;
let upstreamHits = 0;

beforeAll(async () => {
  ctx = await createEngineCtx("disabled-connector");

  mock = await createMockServer((_req, res) => {
    upstreamHits += 1;
    jsonResponse(res, 200, { ok: true });
  });

  // The step names the prod connector; the dev twin shares its slug.
  const [prod] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "mail-oauth",
      display_name: "Mail",
      driver: "http",
      environment: "prod",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
    })
    .returning();
  prodId = prod!.id;
  const [dev] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "mail-oauth",
      display_name: "Mail (dev)",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
      enabled: false,
    })
    .returning();
  devTwinId = dev!.id;
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

async function devTwin() {
  const rows = await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, devTwinId));
  return rows[0]!;
}

/** A draft preview as the HTTP route and the authoring tool start one. */
function previewDraft(steps: unknown[]) {
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "draft", definition: { name: "preview", steps } },
    input: null,
    options: { execution_mode: "dev", hold_writes: true },
  });
}

const readStep = (connector_id: string) => ({
  kind: "request",
  id: "list",
  method: "GET",
  connector_id,
  path: "/messages",
  max_retries: 0,
});

describe("a disabled connector refuses the step as itself", () => {
  test("draft preview against a disabled dev twin answers connector_disabled, naming the twin", async () => {
    upstreamHits = 0;
    const result = await previewDraft([readStep(prodId)]);

    expect(result.status).toBe("failed");
    const error = result.steps[0]?.error as {
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    } | null;
    expect(error?.code).toBe("connector_disabled");
    // The twin the run resolved to — not the prod connector the step names.
    expect(error?.details).toEqual({
      step_id: "list",
      connector_id: devTwinId,
      connector_slug: "mail-oauth",
      connector_name: "Mail (dev)",
      environment: "dev",
      reason: "disabled",
    });
    expect(error?.message).toBe(
      'Connector "mail-oauth" in dev is disabled; enable it before this workflow can run.',
    );
    // Nothing was sent — and nothing fell back to the enabled prod connector.
    expect(upstreamHits).toBe(0);
    // A refusal on our side is no evidence about the remote.
    const twin = await devTwin();
    expect(twin.circuit_failure_count).toBe(0);
    expect(twin.circuit_state).toBe("closed");
  });

  test("the refusal wins over an open breaker on the same twin", async () => {
    upstreamHits = 0;
    await ctx.testDb.db
      .update(connectors)
      .set({ circuit_state: "open", circuit_opened_at: new Date(getTestNow()) })
      .where(eq(connectors.id, devTwinId));
    try {
      const result = await previewDraft([readStep(prodId)]);
      const error = result.steps[0]?.error as { code?: string } | null;
      expect(error?.code).toBe("connector_disabled");
      expect(error?.code).not.toBe("circuit_open");
      expect(upstreamHits).toBe(0);
    } finally {
      await ctx.testDb.db
        .update(connectors)
        .set({ circuit_state: "closed", circuit_opened_at: null })
        .where(eq(connectors.id, devTwinId));
    }
  });

  test("the failed run reads connector_unavailable and names the twin to enable", async () => {
    const result = await previewDraft([readStep(prodId)]);
    expect(result.error?.code).toBe("connector_disabled");

    const [row] = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.id, result.execution_id));
    expect(row?.failure?.connector).toEqual({ connector_id: devTwinId, reason: "disabled" });

    const outcome = deriveExecutionOutcome(
      { status: row!.status, failure: row!.failure, output_contract: row!.output_contract },
      [],
      [{ id: "list", kind: "request" }],
    );
    expect(outcome.cause_class).toBe("connector_unavailable");
    expect(outcome.error_code).toBe("connector_disabled");
    expect(outcome.connector).toEqual({ connector_id: devTwinId, reason: "disabled" });
  });

  test("the exact code classifies before the message matchers", () => {
    // The slug contains "oauth": matched on the sentence alone, the refusal
    // would read as a rejected sign-in.
    expect(
      classifyFailure({
        status: "failed",
        retry_count: 0,
        duration_ms: 0,
        error: {
          code: "connector_disabled",
          message:
            'Connector "mail-oauth" in dev is disabled; enable it before this workflow can run.',
        },
      }),
    ).toBe("connector_unavailable");
  });

  test("once the twin is enabled again the same preview reaches the remote", async () => {
    upstreamHits = 0;
    await ctx.testDb.db
      .update(connectors)
      .set({ enabled: true })
      .where(eq(connectors.id, devTwinId));
    try {
      const result = await previewDraft([readStep(prodId)]);
      expect(result.status).toBe("succeeded");
      expect(upstreamHits).toBe(1);
    } finally {
      await ctx.testDb.db
        .update(connectors)
        .set({ enabled: false })
        .where(eq(connectors.id, devTwinId));
    }
  });
});
