// Service-level integration test for listProposedForAuthoring.
// Uses a real disposable Postgres database (createTestDb) — no mocks.
//
// Verifies:
//  - Three-scope merge: global ∪ connector ∪ workflow candidates all returned
//  - Deduplication on id: workflow > connector > global tiebreak (last-write wins)
//  - Sort order: (scope_specificity desc, confidence_rank desc, evidence_count desc, created_at desc)
//  - Cap at 8 results
//  - Status filter: approved / rejected / superseded excluded; only proposed included

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { tenants } from "../../db/schema/identity.ts";
import { skillCandidateEvidence, skillCandidates } from "../../db/schema/skills.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { listProposedForAuthoring } from "../service.ts";
import type { SkillCandidateView } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;
let other_tenant_id: string;

// Fixed connector + workflow ids used across tests
const CONNECTOR_ID = "00000000-0000-0000-0000-000000000001";
const WORKFLOW_ID = "00000000-0000-0000-0000-000000000002";
const OTHER_WORKFLOW_ID = "00000000-0000-0000-0000-000000000003";

let counter = 0;
function nextFingerprint(): string {
  return `fp-${String(++counter).padStart(6, "0")}`;
}

interface SeedOptions {
  scope: "global" | "connector" | "workflow";
  connector_id?: string;
  workflow_id?: string;
  status?: string;
  confidence?: "low" | "medium" | "high";
  evidence_count?: number;
  created_at_offset_ms?: number;
  title?: string;
}

async function seedCandidate(opts: SeedOptions): Promise<SkillCandidateView> {
  const createdAt = new Date(FROZEN_NOW + (opts.created_at_offset_ms ?? 0));
  const [row] = await ctx.db
    .insert(skillCandidates)
    .values({
      tenant_id,
      scope: opts.scope,
      connector_id: opts.connector_id ?? null,
      workflow_id: opts.workflow_id ?? null,
      pattern_kind: "repair_pattern",
      title: opts.title ?? `Candidate ${opts.scope}`,
      body: `Body for ${opts.scope} candidate`,
      examples: null,
      evidence: [],
      confidence: opts.confidence ?? "medium",
      status: (opts.status as "proposed" | "approved" | "rejected" | "superseded") ?? "proposed",
      fingerprint: nextFingerprint(),
      created_at: createdAt,
      updated_at: createdAt,
    })
    .returning();
  if (!row) throw new Error("seed failed");

  // Add evidence rows if requested
  if (opts.evidence_count && opts.evidence_count > 0) {
    for (let i = 0; i < opts.evidence_count; i++) {
      await ctx.db.insert(skillCandidateEvidence).values({
        skill_candidate_id: row.id,
        evidence_type: "step_success",
        summary: `Evidence ${i}`,
      });
    }
  }

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    scope: row.scope,
    connector_id: row.connector_id,
    workflow_id: row.workflow_id,
    pattern_kind: row.pattern_kind,
    title: row.title,
    body: row.body,
    examples: [],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    evidence_count: opts.evidence_count ?? 0,
    confidence: row.confidence,
    status: row.status,
    promoted_skill_id: row.promoted_skill_id,
    fingerprint: row.fingerprint,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

beforeAll(async () => {
  ctx = await createTestDb("list_proposed_for_authoring");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "lpfa-tenant", display_name: "LPFA Tenant" })
    .returning();
  tenant_id = t!.id;

  const [other] = await ctx.db
    .insert(tenants)
    .values({ slug: "lpfa-other", display_name: "LPFA Other" })
    .returning();
  other_tenant_id = other!.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

afterEach(async () => {
  // Clean up candidates between tests for isolation
  await ctx.db.delete(skillCandidateEvidence);
  await ctx.db.delete(skillCandidates).where(and(eq(skillCandidates.tenant_id, tenant_id)));
  await ctx.db.delete(skillCandidates).where(and(eq(skillCandidates.tenant_id, other_tenant_id)));
}, 10_000);

// ---------------------------------------------------------------------------
// Basic scenarios
// ---------------------------------------------------------------------------

describe("listProposedForAuthoring — basic merge", () => {
  test("returns empty array when tenant has no candidates", async () => {
    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result).toHaveLength(0);
  });

  test("returns global candidates when no scope hints given", async () => {
    await seedCandidate({ scope: "global", title: "Global A" });
    await seedCandidate({ scope: "global", title: "Global B" });
    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result.length).toBe(2);
    const titles = result.map((c) => c.title);
    expect(titles).toContain("Global A");
    expect(titles).toContain("Global B");
  });

  test("merges global + connector candidates when connector_id hint given", async () => {
    await seedCandidate({ scope: "global", title: "Global" });
    await seedCandidate({ scope: "connector", connector_id: CONNECTOR_ID, title: "Connector" });
    const result = await listProposedForAuthoring(
      tenant_id,
      { connector_id: CONNECTOR_ID },
      ctx.db,
    );
    const titles = result.map((c) => c.title);
    expect(titles).toContain("Global");
    expect(titles).toContain("Connector");
  });

  test("merges global + connector + workflow when all hints given", async () => {
    await seedCandidate({ scope: "global", title: "Global" });
    await seedCandidate({ scope: "connector", connector_id: CONNECTOR_ID, title: "Connector" });
    await seedCandidate({ scope: "workflow", workflow_id: WORKFLOW_ID, title: "Workflow" });
    const result = await listProposedForAuthoring(
      tenant_id,
      { connector_id: CONNECTOR_ID, workflow_id: WORKFLOW_ID },
      ctx.db,
    );
    const titles = result.map((c) => c.title);
    expect(titles).toContain("Global");
    expect(titles).toContain("Connector");
    expect(titles).toContain("Workflow");
  });

  test("does NOT include connector-scoped candidates when no connector_id hint", async () => {
    await seedCandidate({ scope: "connector", connector_id: CONNECTOR_ID, title: "ConnectorOnly" });
    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result.every((c) => c.title !== "ConnectorOnly")).toBe(true);
  });

  test("does NOT include workflow-scoped candidates when no workflow_id hint", async () => {
    await seedCandidate({ scope: "workflow", workflow_id: WORKFLOW_ID, title: "WorkflowOnly" });
    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result.every((c) => c.title !== "WorkflowOnly")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Status filter: only proposed
// ---------------------------------------------------------------------------

describe("listProposedForAuthoring — status filter", () => {
  test("excludes approved candidates", async () => {
    await seedCandidate({ scope: "global", title: "Approved", status: "approved" });
    await seedCandidate({ scope: "global", title: "Proposed" });
    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result.some((c) => c.title === "Approved")).toBe(false);
    expect(result.some((c) => c.title === "Proposed")).toBe(true);
  });

  test("excludes rejected candidates", async () => {
    await seedCandidate({ scope: "global", title: "Rejected", status: "rejected" });
    await seedCandidate({ scope: "global", title: "Proposed" });
    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result.some((c) => c.title === "Rejected")).toBe(false);
  });

  test("excludes superseded candidates", async () => {
    await seedCandidate({ scope: "global", title: "Superseded", status: "superseded" });
    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result.some((c) => c.title === "Superseded")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deduplication on id: workflow > connector > global
// ---------------------------------------------------------------------------

describe("listProposedForAuthoring — deduplication tiebreak", () => {
  test("workflow scope wins over connector and global for same fingerprint is not needed — ids are unique, but a row can appear in multiple fetch lists when scoped to different hints", async () => {
    // A global candidate is returned regardless of scope hints.
    // A connector candidate can only appear if connector_id hint matches.
    // These are different rows by design — the dedup is about the Map key (id).
    // We can only test the tiebreak if the SAME id somehow appears in two scope lists.
    // In practice this cannot happen because listSkillCandidates is AND-exact-match
    // and scope is a column — a row has one scope. The dedup guard is defensive.
    // We verify here that we get distinct results with no duplicates.
    await seedCandidate({ scope: "global", title: "G1" });
    await seedCandidate({ scope: "connector", connector_id: CONNECTOR_ID, title: "C1" });
    await seedCandidate({ scope: "workflow", workflow_id: WORKFLOW_ID, title: "W1" });

    const result = await listProposedForAuthoring(
      tenant_id,
      { connector_id: CONNECTOR_ID, workflow_id: WORKFLOW_ID },
      ctx.db,
    );
    const ids = result.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Sort order: scope_specificity desc, confidence_rank desc, evidence_count desc, created_at desc
// ---------------------------------------------------------------------------

describe("listProposedForAuthoring — sort order", () => {
  test("workflow-scoped ranks above connector-scoped above global", async () => {
    await seedCandidate({ scope: "global", confidence: "high", evidence_count: 10, title: "G" });
    await seedCandidate({
      scope: "connector",
      connector_id: CONNECTOR_ID,
      confidence: "high",
      evidence_count: 10,
      title: "C",
    });
    await seedCandidate({
      scope: "workflow",
      workflow_id: WORKFLOW_ID,
      confidence: "high",
      evidence_count: 10,
      title: "W",
    });

    const result = await listProposedForAuthoring(
      tenant_id,
      { connector_id: CONNECTOR_ID, workflow_id: WORKFLOW_ID },
      ctx.db,
    );
    expect(result.length).toBe(3);
    expect(result[0]!.scope).toBe("workflow");
    expect(result[1]!.scope).toBe("connector");
    expect(result[2]!.scope).toBe("global");
  });

  test("within same scope: higher confidence ranks first", async () => {
    await seedCandidate({ scope: "global", confidence: "low", title: "Low" });
    await seedCandidate({ scope: "global", confidence: "high", title: "High" });
    await seedCandidate({ scope: "global", confidence: "medium", title: "Med" });

    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result[0]!.confidence).toBe("high");
    expect(result[1]!.confidence).toBe("medium");
    expect(result[2]!.confidence).toBe("low");
  });

  test("within same scope + confidence: higher evidence_count ranks first", async () => {
    await seedCandidate({
      scope: "global",
      confidence: "medium",
      evidence_count: 1,
      title: "Low Evidence",
    });
    await seedCandidate({
      scope: "global",
      confidence: "medium",
      evidence_count: 5,
      title: "High Evidence",
    });

    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result[0]!.title).toBe("High Evidence");
    expect(result[1]!.title).toBe("Low Evidence");
  });

  test("within same scope + confidence + evidence: newer created_at ranks first", async () => {
    // Seed older first, then newer
    await seedCandidate({
      scope: "global",
      confidence: "medium",
      evidence_count: 3,
      created_at_offset_ms: -10_000,
      title: "Older",
    });
    await seedCandidate({
      scope: "global",
      confidence: "medium",
      evidence_count: 3,
      created_at_offset_ms: 10_000,
      title: "Newer",
    });

    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result[0]!.title).toBe("Newer");
    expect(result[1]!.title).toBe("Older");
  });
});

// ---------------------------------------------------------------------------
// Cap at 8 results
// ---------------------------------------------------------------------------

describe("listProposedForAuthoring — cap at 8", () => {
  test("returns at most 8 candidates even when more are available", async () => {
    // Seed 12 global candidates
    for (let i = 0; i < 12; i++) {
      await seedCandidate({ scope: "global", title: `Bulk ${i}` });
    }
    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result.length).toBeLessThanOrEqual(8);
  });

  test("returns at most 8 when spread across scopes", async () => {
    for (let i = 0; i < 5; i++) {
      await seedCandidate({ scope: "global", title: `G${i}` });
    }
    for (let i = 0; i < 5; i++) {
      await seedCandidate({ scope: "connector", connector_id: CONNECTOR_ID, title: `C${i}` });
    }
    for (let i = 0; i < 5; i++) {
      await seedCandidate({ scope: "workflow", workflow_id: WORKFLOW_ID, title: `W${i}` });
    }
    const result = await listProposedForAuthoring(
      tenant_id,
      { connector_id: CONNECTOR_ID, workflow_id: WORKFLOW_ID },
      ctx.db,
    );
    expect(result.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation: wrong tenant returns empty
// ---------------------------------------------------------------------------

describe("listProposedForAuthoring — tenant isolation", () => {
  test("candidates for other_tenant_id are not returned for tenant_id", async () => {
    // Seed for other tenant
    await ctx.db.insert(skillCandidates).values({
      tenant_id: other_tenant_id,
      scope: "global",
      pattern_kind: "repair_pattern",
      title: "Other Tenant Candidate",
      body: "Should not appear",
      evidence: [],
      confidence: "high",
      fingerprint: nextFingerprint(),
    });
    // Seed for this tenant
    await seedCandidate({ scope: "global", title: "My Candidate" });

    const result = await listProposedForAuthoring(tenant_id, {}, ctx.db);
    expect(result.some((c) => c.title === "Other Tenant Candidate")).toBe(false);
    expect(result.some((c) => c.title === "My Candidate")).toBe(true);
  });

  test("querying other_tenant_id returns only that tenant's candidates", async () => {
    await ctx.db.insert(skillCandidates).values({
      tenant_id: other_tenant_id,
      scope: "global",
      pattern_kind: "repair_pattern",
      title: "Other Only",
      body: "Body",
      evidence: [],
      confidence: "low",
      fingerprint: nextFingerprint(),
    });
    await seedCandidate({ scope: "global", title: "Mine" });

    const result = await listProposedForAuthoring(other_tenant_id, {}, ctx.db);
    expect(result.some((c) => c.title === "Mine")).toBe(false);
    expect(result.some((c) => c.title === "Other Only")).toBe(true);
  });
});
