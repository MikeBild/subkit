// Journey 33: Skill candidate rejection blocks re-proposal.
//
// Propose a candidate, reject it, re-run analysis, verify same
// fingerprint doesn't produce a new candidate.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { patchCandidates, workflows } from "../../db/schema/index.ts";
import { runPatternAnalysis } from "../../skill-candidates/service.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

beforeAll(async () => {
  ctx = await createJourneyCtx("rejection");

  const [wf] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenantId,
      slug: "reject-wf",
      name: "Rejection Test WF",
      lifecycle: "active",
    })
    .returning();

  // Seed 5 patches
  for (let i = 0; i < 5; i++) {
    await ctx.db.insert(patchCandidates).values({
      tenant_id: ctx.tenantId,
      workflow_id: wf!.id,
      diff: { kind: "rename_param", path: "api_key" },
      classification: "safe",
      status: "applied",
    });
  }
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe("journey: skill candidate rejection blocks re-proposal", () => {
  let candidateId: string;

  test("AC1: analysis proposes candidate", async () => {
    const result = await runPatternAnalysis({ tenant_id: ctx.tenantId }, ctx.db);
    expect(result.candidates_proposed).toBeGreaterThanOrEqual(1);
  });

  test("AC2: reject the candidate", async () => {
    const listRes = await journeyFetch(ctx, "/v1/skill-candidates?status=proposed");
    const list = (await listRes.json()) as { items: Array<{ id: string }> };
    candidateId = list.items[0]!.id;

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
