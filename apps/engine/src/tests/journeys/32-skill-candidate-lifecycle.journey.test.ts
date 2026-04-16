// Journey 32: Skill candidate lifecycle via REST API.
//
// Seed patch data, run pattern analysis, verify candidate proposed,
// approve it, and verify the skill was created.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, patchCandidates, workflows } from "../../db/schema/index.ts";
import { runPatternAnalysis } from "../../skill-candidates/service.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let workflowId: string;

beforeAll(async () => {
  ctx = await createJourneyCtx("skill-candidate");

  // Seed a workflow
  const [wf] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenantId,
      slug: "sc-test-wf",
      name: "SC Test Workflow",
      lifecycle: "active",
    })
    .returning();
  workflowId = wf!.id;

  // Seed 5 applied patches with same pattern
  for (let i = 0; i < 5; i++) {
    await ctx.db.insert(patchCandidates).values({
      tenant_id: ctx.tenantId,
      workflow_id: workflowId,
      diff: { kind: "update_field_path", path: "data.customer_id" },
      classification: "safe",
      status: "applied",
    });
  }
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe("journey: skill candidate lifecycle", () => {
  let candidateId: string;

  test("AC1: pattern analysis detects repair pattern", async () => {
    const result = await runPatternAnalysis({ tenant_id: ctx.tenantId }, ctx.db);
    expect(result.candidates_proposed).toBeGreaterThanOrEqual(1);
  });

  test("AC2: list candidates shows proposed", async () => {
    const res = await journeyFetch(ctx, "/v1/skill-candidates?status=proposed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; pattern_kind: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const candidate = body.items.find((c) => c.pattern_kind === "repair_pattern");
    expect(candidate).toBeDefined();
    candidateId = candidate!.id;
  });

  test("AC3: get candidate shows details", async () => {
    const res = await journeyFetch(ctx, `/v1/skill-candidates/${candidateId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      evidence_count: number;
      confidence: string;
    };
    expect(body.evidence_count).toBeGreaterThanOrEqual(5);
  });

  test("AC4: approve candidate creates skill", async () => {
    const res = await journeyFetch(ctx, `/v1/skill-candidates/${candidateId}/approve`, {
      method: "POST",
      body: JSON.stringify({ status: "draft" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skill_id: string; candidate: { status: string } };
    expect(body.skill_id).toBeDefined();
    expect(body.candidate.status).toBe("approved");

    // Verify skill exists
    const skillRes = await journeyFetch(ctx, `/v1/skills/${body.skill_id}`);
    expect(skillRes.status).toBe(200);
  });

  test("AC5: re-analysis doesn't re-propose approved pattern", async () => {
    const result = await runPatternAnalysis({ tenant_id: ctx.tenantId }, ctx.db);
    // Should skip since the fingerprint is already approved
    expect(result.candidates_proposed).toBe(0);
  });

  test("AC6: audit trail complete", async () => {
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource_id, candidateId));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("skill_candidate.proposed");
    expect(actions).toContain("skill_candidate.approved");
  });
});
