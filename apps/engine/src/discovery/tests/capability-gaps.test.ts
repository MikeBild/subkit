// Capability-gap candidate loop — recordGapCandidate + listCapabilityGaps.
//
// Verifies the cannot_help -> durable gap signal: a gap is persisted as a
// capability_gap discovery artifact, recurring gaps dedup by fingerprint
// and bump an occurrence counter (the demand signal), distinct gaps get
// distinct rows, and the list is demand-ranked. Running this also proves
// migration 0006 (the capability_gap enum value) applies on a fresh DB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { auditLog } from "../../db/schema/audit.ts";
import { discoveryArtifacts } from "../../db/schema/discovery.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { listCapabilityGaps, recordGapCandidate } from "../service.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("cap-gaps");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "cap-gaps", display_name: "Capability Gaps" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
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
    // A gap has no source files — evidence is empty.
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
    // No new row — same fingerprint just incremented.
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
    // stripe.refunds has 2 occurrences, slack.chat has 1 → stripe first.
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
    // At least the two distinct first-occurrence inserts are audited
    // (occurrence bumps do not re-audit).
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
});
