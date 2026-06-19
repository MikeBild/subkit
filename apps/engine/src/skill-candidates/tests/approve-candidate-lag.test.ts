// Integration test for the drift→skill lag computation inside
// `approveSkillCandidate` (the loop's promotion edge). This is the
// one new emit site whose correctness lives in DB behaviour the unit test
// (observability/tests/loop-closure-metrics.test.ts) cannot exercise:
//   * the two-hop join skill_candidate_evidence → patch_candidates,
//   * `orderBy(asc(created_at)).limit(1)` selecting the EARLIEST linked patch
//     (the load-bearing "true drift→skill journey" claim), and
//   * the no-patch-evidence branch leaving the lag histogram untouched.
// Requires a real Postgres database — set REQUIRES_PG=0 to skip.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { patchCandidates } from "../../db/schema/executions.ts";
import { tenants, workflows } from "../../db/schema/index.ts";
import { skillCandidateEvidence, skillCandidates } from "../../db/schema/skills.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../../observability/metrics.ts";
import {
  createDeterministicClock,
  FROZEN_NOW,
  installClock,
  restoreClock,
} from "../../test-helpers/determinism/clock.ts";
import { approveSkillCandidate } from "../service.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let workflowId: string;

// --- metrics snapshot helpers (mirrors loop-closure-metrics.test.ts) --------

function counterSample(metricName: string, labels: Record<string, string>): number | undefined {
  const series = getMetrics()
    .snapshot()
    .find((s) => s.name === metricName);
  return series?.samples.find((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))
    ?.value;
}

function histogramCount(metricName: string, labels: Record<string, string>): number {
  const series = getMetrics()
    .snapshot()
    .find((s) => s.name === metricName);
  return (
    series?.samples.find(
      (s) =>
        s.name === `${metricName}_count` &&
        Object.entries(labels).every(([k, v]) => s.labels[k] === v),
    )?.value ?? 0
  );
}

function histogramSum(metricName: string, labels: Record<string, string>): number {
  const series = getMetrics()
    .snapshot()
    .find((s) => s.name === metricName);
  return (
    series?.samples.find(
      (s) =>
        s.name === `${metricName}_sum` &&
        Object.entries(labels).every(([k, v]) => s.labels[k] === v),
    )?.value ?? 0
  );
}

async function seedProposedCandidate(
  patternKind: "repair_pattern" | "success_pattern",
  tag: string,
) {
  const [candidate] = await testDb.db
    .insert(skillCandidates)
    .values({
      tenant_id: tenantId,
      scope: "global",
      pattern_kind: patternKind,
      title: `Candidate ${tag}`,
      body: "body",
      evidence: { summary: `evidence ${tag}` },
      confidence: "high",
      fingerprint: `fp-${tag}`,
      status: "proposed",
    })
    .returning();
  if (!candidate) throw new Error("seed candidate failed");
  return candidate.id;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("sc-approve-lag");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "sc-approve-lag", display_name: "SC Approve Lag" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  const [wf] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug: "wf", name: "Workflow", lifecycle: "active" })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  workflowId = wf.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

afterEach(() => {
  // The service reads time through the production clock seam (`now()`); restore
  // wall-clock after each test so a frozen clock never leaks across tests.
  restoreClock(null);
});

describe.skipIf(skip)("approveSkillCandidate — drift→skill lag telemetry", () => {
  test("lag anchors to the EARLIEST linked patch candidate", async () => {
    resetMetricsRegistryForTests();
    // Freeze the clock the service reads, so the lag is exact and reproducible.
    installClock(createDeterministicClock(FROZEN_NOW));

    // Two patch candidates at different ages. The lag must track the OLDER
    // one (drift first detected 2h ago), not the 10-min-old one.
    const earlyCreatedAt = new Date(FROZEN_NOW - 7200 * 1000); // 2 hours ago
    const lateCreatedAt = new Date(FROZEN_NOW - 600 * 1000); // 10 minutes ago

    const [patchEarly] = await testDb.db
      .insert(patchCandidates)
      .values({
        tenant_id: tenantId,
        workflow_id: workflowId,
        diff: { kind: "rename", path: "a" },
        classification: "safe",
        status: "proposed",
        created_at: earlyCreatedAt,
        updated_at: earlyCreatedAt,
      })
      .returning();
    const [patchLate] = await testDb.db
      .insert(patchCandidates)
      .values({
        tenant_id: tenantId,
        workflow_id: workflowId,
        diff: { kind: "rename", path: "b" },
        classification: "safe",
        status: "proposed",
        created_at: lateCreatedAt,
        updated_at: lateCreatedAt,
      })
      .returning();
    if (!patchEarly || !patchLate) throw new Error("seed patch candidates failed");

    const candidateId = await seedProposedCandidate("repair_pattern", "repair");
    await testDb.db.insert(skillCandidateEvidence).values([
      {
        skill_candidate_id: candidateId,
        patch_candidate_id: patchLate.id,
        evidence_type: "patch_applied",
        summary: "later patch",
      },
      {
        skill_candidate_id: candidateId,
        patch_candidate_id: patchEarly.id,
        evidence_type: "patch_applied",
        summary: "earlier patch",
      },
    ]);

    const result = await approveSkillCandidate(
      { tenant_id: tenantId, candidate_id: candidateId, actor_id: null },
      testDb.db,
    );
    expect(result).not.toBeNull();

    // Promotion counter fired exactly once for this tenant.
    expect(
      counterSample(METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL, {
        tenant_id: tenantId,
        source: "auto-suggested",
      }),
    ).toBe(1);

    // Exactly one lag observation, anchored to the EARLIEST patch (~7200s).
    expect(
      histogramCount(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, { tenant_id: tenantId }),
    ).toBe(1);
    const sum = histogramSum(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, {
      tenant_id: tenantId,
    });
    // Frozen clock → exact lag to the 2h-old patch (7200s), proving asc+limit 1
    // selected the EARLIEST linked patch, not the 10-min-old one (600s).
    expect(sum).toBe(7200);
  });

  test("candidate with no patch evidence promotes without a lag observation", async () => {
    resetMetricsRegistryForTests();
    installClock(createDeterministicClock(FROZEN_NOW));

    const candidateId = await seedProposedCandidate("success_pattern", "success");
    // Evidence with NO patch link (success pattern → execution-only evidence).
    await testDb.db.insert(skillCandidateEvidence).values({
      skill_candidate_id: candidateId,
      patch_candidate_id: null,
      evidence_type: "step_success",
      summary: "no patch link",
    });

    const result = await approveSkillCandidate(
      { tenant_id: tenantId, candidate_id: candidateId, actor_id: null },
      testDb.db,
    );
    expect(result).not.toBeNull();

    // Promotion counter still fires...
    expect(
      counterSample(METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL, {
        tenant_id: tenantId,
        source: "auto-suggested",
      }),
    ).toBe(1);
    // ...but the lag histogram records nothing (no true drift→skill journey).
    expect(
      histogramCount(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, { tenant_id: tenantId }),
    ).toBe(0);
  });
});
