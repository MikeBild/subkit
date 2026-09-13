// Journey 33: Skill candidate rejection blocks re-proposal.
//
// Seeds applied patch_candidates with the real diff shape (proposal nested
// under diff.proposal) plus execution_fixtures so the repair-pattern detector
// can inner-join on fixture_id → connector_id/endpoint_key. Proposes a
// connector-scoped candidate, rejects it, re-runs analysis, and verifies the
// same fingerprint does not produce a new candidate.

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

// A timestamp well within the 30-day lookback window used by the detector.
// allow-wall-clock: anchor for patch created_at — the detector computes its
// own cutoff via now(), which falls back to Date.now() with no test override,
// so tests must stay within the real 30-day window.
const RECENT_TS = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago

beforeAll(async () => {
  ctx = await createJourneyCtx("rejection");

  // Seed a connector — the repair-pattern detector groups by connector_id.
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

  // The workflow exists only to satisfy patch_candidates.workflow_id (a NOT
  // NULL FK). The rescoped detector groups by connector/endpoint, not by
  // workflow, so the journey never asserts against it — keep the seed.
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

  // Seed 5 applied patches on the same (connector, endpoint, kind) interface,
  // each with its own execution_fixture, so the detector forms one group.
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
