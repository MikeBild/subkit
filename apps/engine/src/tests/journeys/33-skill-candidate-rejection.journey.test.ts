import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connectors,
  executionFixtures,
  patchCandidates,
  workflows,
} from "../../db/schema/index.ts";
import { runPatternAnalysis } from "../../skill-candidates/service.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let connectorId: string;

// allow-wall-clock: anchor for patch created_at — the detector computes its
// own cutoff via now(), which falls back to Date.now() with no test override,
// so tests must stay within the real 30-day window.
const RECENT_TS = new Date(Date.now() - 24 * 60 * 60 * 1000);

beforeAll(async () => {
  ctx = await createJourneyCtx("rejection");

  const [conn] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "reject-test-api",
      display_name: "Reject Test API",
      driver: "http",
    })
    .returning();
  if (!conn) throw new Error("seed connector failed");
  connectorId = conn.id;

  const [wf] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenantId,
      slug: "reject-wf",
      name: "Rejection Test WF",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");

  for (let i = 0; i < 5; i++) {
    const [fix] = await ctx.db
      .insert(executionFixtures)
      .values({
        tenant_id: ctx.tenantId,
        connector_id: connectorId,
        endpoint_key: "create_item",
        request: {},
        response: {},
      })
      .returning();
    if (!fix) throw new Error(`seed fixture ${i} failed`);

    await ctx.db.insert(patchCandidates).values({
      tenant_id: ctx.tenantId,
      workflow_id: wf.id,
      diff: {
        proposal: {
          classification: "safe",
          kind: "rename_param",
          description: "parameter naming convention on this endpoint",
          patch: { from: "api_key", to: "apiKey" },
          reasoning: "observed drift on every run",
        },
        drift_signal: {},
        dry_run: { ok: true, error: null, fixture_id: null, skipped: false },
        policy: {},
        step_id: `step-${i}`,
        execution_id: `exec-${i}`,
        source: "test",
      },
      classification: "safe",
      fixture_id: fix.id,
      status: "applied",
      created_at: RECENT_TS,
      updated_at: RECENT_TS,
    });
  }
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: skill candidate rejection blocks re-proposal", () => {
  let candidateId: string;

  test("AC1: analysis proposes a connector-scoped candidate", async () => {
    const result = await runPatternAnalysis({ tenant_id: ctx.tenantId }, ctx.db);
    expect(result.candidates_proposed).toBeGreaterThanOrEqual(1);
  });

  test("AC2: reject the candidate", async () => {
    const listRes = await journeyFetch(ctx, "/v1/skill-candidates?status=proposed");
    const list = (await listRes.json()) as {
      items: Array<{ id: string; scope: string; connector_id: string | null }>;
    };
    const candidate = list.items.find((c) => c.scope === "connector");
    expect(candidate).toBeDefined();
    expect(candidate!.connector_id).toBe(connectorId);
    candidateId = candidate!.id;

    const res = await journeyFetch(ctx, `/v1/skill-candidates/${candidateId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: "not useful for our workflow" }),
    });
    expect(res.status).toBe(200);
  });

  test("AC3: re-analysis does NOT re-propose same fingerprint", async () => {
    const result = await runPatternAnalysis({ tenant_id: ctx.tenantId }, ctx.db);
    expect(result.candidates_proposed).toBe(0);
  });

  test("AC4: candidate status is rejected", async () => {
    const res = await journeyFetch(ctx, `/v1/skill-candidates/${candidateId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("rejected");
  });
});
