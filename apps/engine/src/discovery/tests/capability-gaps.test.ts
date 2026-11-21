import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { discoveryArtifacts } from "../../db/schema/discovery.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  listCapabilityGaps,
  recordGapCandidate,
  rejectDiscoveryArtifact,
  resolveCapabilityGap,
  toCapabilityGapView,
} from "../service.ts";

const skip = testEnv.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("cap-gaps");
  tenantId = (await seedTenant(testDb.db, { slug: "cap-gaps", display_name: "Capability Gaps" }))
    .id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

describe.skipIf(skip)("discovery/capability-gaps", () => {
  test("records a first gap as a proposed capability_gap artifact", async () => {
    const view = await recordGapCandidate(
      {
        tenant_id: tenantId,
        conversation_id: "conv-1",
        requested: "Refund a Stripe payment for a customer",
        missing_capability: "connector.stripe.refunds",
        suggested_kind: "connector",
      },
      testDb.db,
    );
    expect(view).not.toBeNull();
    expect(view!.kind).toBe("capability_gap");
    expect(view!.status).toBe("proposed");
    const draft = view!.draft as Record<string, unknown>;
    expect(draft.missing_capability).toBe("connector.stripe.refunds");
    expect(draft.occurrences).toBe(1);
    expect(draft.suggested_kind).toBe("connector");
    expect(typeof draft.fingerprint).toBe("string");
    expect(view!.evidence.file_ids).toEqual([]);
    expect(view!.evidence.excerpts).toEqual([]);
  });

  test("the same capability dedups and bumps the occurrence counter", async () => {
    const before = await listCapabilityGaps({ tenant_id: tenantId }, testDb.db);
    const beforeCount = before.length;

    const view = await recordGapCandidate(
      {
        tenant_id: tenantId,
        conversation_id: "conv-2",
        requested: "Issue a refund on Stripe",
        missing_capability: "connector.stripe.refunds",
      },
      testDb.db,
    );
    expect(view).not.toBeNull();
    expect((view!.draft as Record<string, unknown>).occurrences).toBe(2);

    const after = await listCapabilityGaps({ tenant_id: tenantId }, testDb.db);
    expect(after.length).toBe(beforeCount);
  });

  test("a distinct capability creates a separate row", async () => {
    const view = await recordGapCandidate(
      {
        tenant_id: tenantId,
        conversation_id: "conv-3",
        requested: "Post a message to a Slack channel",
        missing_capability: "connector.slack.chat",
      },
      testDb.db,
    );
    expect(view).not.toBeNull();
    expect((view!.draft as Record<string, unknown>).occurrences).toBe(1);

    const rows = await testDb.db
      .select()
      .from(discoveryArtifacts)
      .where(
        and(
          eq(discoveryArtifacts.tenant_id, tenantId),
          eq(discoveryArtifacts.kind, "capability_gap"),
        ),
      );
    expect(rows.length).toBe(2);
  });

  test("listCapabilityGaps is demand-ranked (most-requested first)", async () => {
    const gaps = await listCapabilityGaps({ tenant_id: tenantId }, testDb.db);
    expect(gaps.length).toBe(2);
    expect((gaps[0]!.draft as Record<string, unknown>).missing_capability).toBe(
      "connector.stripe.refunds",
    );
    expect((gaps[0]!.draft as Record<string, unknown>).occurrences).toBe(2);
  });

  test("recording a gap writes an audit entry", async () => {
    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "discovery.artifact_proposed")),
      );
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const meta = audits.map((a) => a.metadata as Record<string, unknown> | null);
    expect(meta.some((m) => m?.kind === "capability_gap")).toBe(true);
  });

  test("a blank dedup key is rejected (no row written)", async () => {
    const view = await recordGapCandidate(
      {
        tenant_id: tenantId,
        conversation_id: null,
        requested: "   ",
        missing_capability: null,
      },
      testDb.db,
    );
    expect(view).toBeNull();
  });

  test("resolving an open gap records the note, the resolved state and an audit entry", async () => {
    const gap = await recordGapCandidate(
      {
        tenant_id: tenantId,
        conversation_id: "conv-resolve",
        requested: "Switch from connector to workflow authoring",
        missing_capability: "surface.authoring_mode_switch",
      },
      testDb.db,
    );
    if (!gap) throw new Error("gap not recorded");
    expect(toCapabilityGapView(gap).state).toBe("open");

    const resolved = await resolveCapabilityGap(
      { tenant_id: tenantId, artifact_id: gap.id, note: "Mode switch shipped." },
      testDb.db,
    );
    if (!resolved) throw new Error("gap not resolved");
    const view = toCapabilityGapView(resolved);
    expect(view.status).toBe("superseded");
    expect(view.state).toBe("resolved");
    expect(view.resolution?.note).toBe("Mode switch shipped.");
    expect(view.occurrences).toBe(1);

    const audits = await testDb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, gap.id)));
    expect(audits.map((a) => a.action)).toContain("discovery.artifact_superseded");

    const open = await listCapabilityGaps({ tenant_id: tenantId, status: "proposed" }, testDb.db);
    expect(open.some((g) => g.id === gap.id)).toBe(false);
    const again = await resolveCapabilityGap(
      { tenant_id: tenantId, artifact_id: gap.id, note: "twice" },
      testDb.db,
    );
    expect(again).toBeNull();
  });

  test("declined gaps and other artifact kinds cannot be resolved", async () => {
    const gap = await recordGapCandidate(
      {
        tenant_id: tenantId,
        conversation_id: "conv-decline",
        requested: "Delete another conversation",
        missing_capability: "surface.conversation.delete.other",
      },
      testDb.db,
    );
    if (!gap) throw new Error("gap not recorded");
    await rejectDiscoveryArtifact(
      { tenant_id: tenantId, artifact_id: gap.id, actor_id: null, reason: "by design" },
      testDb.db,
    );
    const resolved = await resolveCapabilityGap(
      { tenant_id: tenantId, artifact_id: gap.id, note: "n/a" },
      testDb.db,
    );
    expect(resolved).toBeNull();
    const [row] = await testDb.db
      .select({
        status: discoveryArtifacts.status,
        rejection_reason: discoveryArtifacts.rejection_reason,
      })
      .from(discoveryArtifacts)
      .where(eq(discoveryArtifacts.id, gap.id));
    expect(row?.status).toBe("rejected");
    expect(row?.rejection_reason).toBe("by design");
  });
});
