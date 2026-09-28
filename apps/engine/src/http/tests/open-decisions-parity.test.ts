// "What's waiting" is one number on every surface.
//
// One installation said 48 in the MCP connect instructions (the digest counted
// every `proposed` row), 50 in the digest headline (it counted a list capped at
// 50) and 0 on the cockpit decisions page (the list's `reviewable_total`
// filtered by readiness). Three predicates for one question.
//
// This seeds open decisions next to proposed rows no human can decide, and
// holds the four surfaces to the same answer: the digest's `open`, the MCP
// attention line, `GET /v1/patch-candidates` `reviewable_total`, and the
// operational overview's decision tiles.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { patchCandidates } from "../../db/schema/index.ts";
import {
  buildOperatorHealthDigest,
  buildOperatorHealthSummary,
} from "../../operator/health-digest.ts";
import {
  getOperationalOverview,
  invalidateOperationalOverview,
} from "../../operator/operational-overview.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  noChangeDiff,
  reviewableDiff,
  seedPatchableWorkflow,
} from "../../test-helpers/patch-candidates.ts";
import { adminPrincipal } from "../../test-helpers/principals.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
const OPEN = 3;

beforeAll(async () => {
  srv = await createHttpTestServer("open_decisions_parity");
  const wf = await seedPatchableWorkflow(srv.db, srv.tenantId, "parity", "Parity");
  const now = getTestNow();
  const base = {
    tenant_id: srv.tenantId,
    workflow_id: wf.workflow_id,
    classification: "safe" as const,
    status: "proposed" as const,
  };
  await srv.db.insert(patchCandidates).values([
    // Open: one past the 72-hour overdue line, two recent.
    { ...base, created_at: new Date(now - 5 * 24 * 3600_000), diff: reviewableDiff("old") },
    { ...base, created_at: new Date(now - 3600_000), diff: reviewableDiff("fresh a") },
    { ...base, created_at: new Date(now - 7200_000), diff: reviewableDiff("fresh b") },
    // Proposed but undecidable on the current version — not open anywhere.
    { ...base, diff: noChangeDiff("to itself a") },
    { ...base, diff: noChangeDiff("to itself b") },
    // Proposed, step gone — not reviewable, not closed, not counted.
    { ...base, diff: reviewableDiff("gone", { workflow_step_id: "missing" }) },
    // Decided — never open.
    { ...base, status: "rejected" as const, diff: reviewableDiff("rejected") },
  ]);
});

afterAll(async () => {
  await srv.cleanup();
});

test("digest, MCP attention line, list reviewable_total and overview report the same open count", async () => {
  const digest = await buildOperatorHealthDigest(srv.db, adminPrincipal(srv.tenantId));
  expect(digest.patch_candidates.open).toBe(OPEN);
  // Three open fixes on one workflow are one thing to decide; the item carries
  // the exact count behind it.
  expect(digest.headline).toBe("Needs attention: 1 item (1 to decide).");
  expect(digest.attention.items[0]?.counts.patches).toBe(OPEN);

  const summary = await buildOperatorHealthSummary(srv.db, adminPrincipal(srv.tenantId));
  expect(summary.text).toContain(`(${OPEN} fixes)`);

  const res = await fetch(`${srv.baseUrl}/v1/patch-candidates?status=proposed`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
  expect(res.status).toBe(200);
  const list = (await res.json()) as { total: number; reviewable_total: number };
  expect(list.total).toBe(6);
  expect(list.reviewable_total).toBe(OPEN);

  invalidateOperationalOverview(srv.tenantId);
  const overview = await getOperationalOverview(srv.db, srv.tenantId);
  // No skill candidates are seeded, so the two non-blocking decision tiles
  // hold exactly the open patch decisions.
  expect(overview.core.overdue.value).toBe(1);
  expect((overview.core.overdue.value ?? 0) + (overview.core.other_decisions.value ?? 0)).toBe(
    OPEN,
  );
});
