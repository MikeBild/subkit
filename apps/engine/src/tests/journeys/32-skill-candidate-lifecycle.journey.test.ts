// Journey 32: Skill candidate lifecycle via REST API.
//
// Seeds applied patch_candidates with the real diff shape (proposal nested
// under diff.proposal) and execution_fixtures so the repair-pattern detector
// can inner-join on fixture_id → connector_id/endpoint_key. Runs pattern
// analysis, verifies a connector-scoped candidate is proposed, approves it,
// and verifies the skill was created.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  auditLog,
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
// cutoff via now() (falls back to Date.now() with no override installed), so
// tests must stay within the real 30-day window.
const RECENT_TS = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago

beforeAll(async () => {
  ctx = await createJourneyCtx("skill-candidate");

  // Seed a connector — the repair-pattern detector groups by connector_id.
  const [conn] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "sc-test-api",
      display_name: "SC Test API",
      driver: "http",
    })
    .returning();
  if (!conn) throw new Error("seed connector failed");
  connectorId = conn.id;

  // Seed 3 workflows — patches on DIFFERENT workflows must still form one group.
  const seedWorkflowIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const [wf] = await ctx.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenantId,
        slug: `sc-test-wf-${i}`,
        name: `SC Test Workflow ${i}`,
        lifecycle: "active",
      })
      .returning();
    if (!wf) throw new Error(`seed workflow ${i} failed`);
    seedWorkflowIds.push(wf.id);
  }

  // For each workflow, seed an execution_fixture and a matching applied
  // patch_candidate with the REAL diff shape (proposal nested under diff.proposal).
  // This lets the detector inner-join to execution_fixtures for connector context.
  for (let i = 0; i < seedWorkflowIds.length; i++) {
    const [fix] = await ctx.db
      .insert(executionFixtures)
      .values({
        tenant_id: ctx.tenantId,
        connector_id: connectorId,
        endpoint_key: "get_customers",
        request: {},
        response: {},
      })
      .returning();
    if (!fix) throw new Error(`seed fixture ${i} failed`);

    await ctx.db.insert(patchCandidates).values({
      tenant_id: ctx.tenantId,
      workflow_id: seedWorkflowIds[i]!,
      diff: {
        proposal: {
          classification: "safe",
          kind: "update_field_path",
          description: "field path convention on this endpoint",
          patch: {
            path: "/data/customer_id",
            value: "/data/result/customer_id",
          },
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

describe("journey: skill candidate lifecycle", () => {
  let candidateId: string;

  test("AC1: pattern analysis proposes exactly 1 repair_pattern candidate from the one connector/endpoint group", async () => {
    const result = await runPatternAnalysis({ tenant_id: ctx.tenantId }, ctx.db);
    // The seed creates exactly 3 patches on one connector + one endpoint_key
    // ("get_customers"). The repair-pattern detector groups by
    // (connector_id, endpoint_key, kind), so exactly 1 candidate is proposed.
    expect(result.candidates_proposed).toBe(1);
  });

  test("AC2: list candidates shows exactly one connector-scoped proposed repair_pattern", async () => {
    const res = await journeyFetch(ctx, "/v1/skill-candidates?status=proposed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        pattern_kind: string;
        scope: string;
        connector_id: string | null;
        workflow_id: string | null;
        evidence_count: number;
      }>;
      total: number;
    };
    // There is exactly one proposed repair_pattern candidate.
    const repairCandidates = body.items.filter((c) => c.pattern_kind === "repair_pattern");
    expect(repairCandidates).toHaveLength(1);
    const candidate = repairCandidates[0]!;
    expect(candidate.scope).toBe("connector");
    expect(candidate.connector_id).toBe(connectorId);
    // No workflow_id on a connector-scoped signal.
    expect(candidate.workflow_id).toBeNull();
    candidateId = candidate.id;
    expect(body.total).toBe(body.items.length);

    // `total` is the true matching count, independent of the page cap.
    const capped = await journeyFetch(ctx, "/v1/skill-candidates?status=proposed&limit=1");
    expect(capped.status).toBe(200);
    const cappedBody = (await capped.json()) as { items: unknown[]; total: number };
    expect(cappedBody.items.length).toBeLessThanOrEqual(1);
    expect(cappedBody.total).toBe(body.items.length);
  });

  test("AC3: get candidate shows evidence_count === 3 (exactly the seeded patches)", async () => {
    const res = await journeyFetch(ctx, `/v1/skill-candidates/${candidateId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      scope: string;
      connector_id: string | null;
      evidence_count: number;
      confidence: string;
    };
    expect(body.scope).toBe("connector");
    expect(body.connector_id).toBe(connectorId);
    // Exactly 3 applied patches were seeded for one endpoint — evidence_count must be 3.
    expect(body.evidence_count).toBe(3);
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

    // Verify skill exists.
    const skillRes = await journeyFetch(ctx, `/v1/skills/${body.skill_id}`);
    expect(skillRes.status).toBe(200);
  });

  test("AC5: re-analysis does not re-propose an already-approved pattern", async () => {
    const result = await runPatternAnalysis({ tenant_id: ctx.tenantId }, ctx.db);
    // The fingerprint is already approved, so no new candidate is proposed.
    expect(result.candidates_proposed).toBe(0);
  });

  test("AC6: audit trail contains SKILL_CANDIDATE_PROPOSED with scope and connector_id metadata", async () => {
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource_id, candidateId));

    const actions = audits.map((a) => a.action);
    expect(actions).toContain("skill_candidate.proposed");
    expect(actions).toContain("skill_candidate.approved");

    const proposedRow = audits.find((a) => a.action === "skill_candidate.proposed");
    expect(proposedRow).toBeDefined();
    const meta = proposedRow!.metadata as Record<string, unknown>;
    expect(meta.scope).toBe("connector");
    expect(meta.connector_id).toBe(connectorId);
  });
});
