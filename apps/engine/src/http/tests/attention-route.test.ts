import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  apiKeys,
  auditLog,
  patchCandidates,
  skillCandidates,
  users,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import type { AttentionV1 } from "../../operator/attention.ts";
import { invalidateAttention } from "../../operator/attention.ts";
import {
  buildOperatorHealthSummary,
  type OperatorHealthDigest,
} from "../../operator/health-digest.ts";
import { invalidateOperationalOverview } from "../../operator/operational-overview.ts";
import { grantResource } from "../../rbac/grants.ts";
import { builtinRoleId, createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { reviewableDiff, seedPatchableWorkflow } from "../../test-helpers/patch-candidates.ts";
import { adminPrincipal } from "../../test-helpers/principals.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let heldId: string;
let patchedId: string;
let scopedKey: string;
let scopedPrincipal: ResolvedPrincipal;

const SCOPED_KEY = "wf_live_attention_scoped_0001";

beforeAll(async () => {
  srv = await createHttpTestServer("attention_route");
  heldId = (await seedPatchableWorkflow(srv.db, srv.tenantId, "held", "Held")).workflow_id;
  patchedId = (await seedPatchableWorkflow(srv.db, srv.tenantId, "patched", "Patched")).workflow_id;
  await srv.db.insert(workflowsSchedules).values({
    tenant_id: srv.tenantId,
    workflow_id: heldId,
    cron: "0 * * * *",
    admission_hold: {
      reason_code: "execution_authority_required",
      observed_at: new Date(getTestNow()).toISOString(),
    },
  });
  await srv.db.insert(patchCandidates).values(
    ["a", "b"].map((d) => ({
      tenant_id: srv.tenantId,
      workflow_id: patchedId,
      classification: "safe" as const,
      status: "proposed" as const,
      diff: reviewableDiff(d),
    })),
  );

  const role = await createRole(srv.db, srv.tenantId, "attention-observer");
  await grantPermissionToRole(srv.db, srv.tenantId, role.id, "stats:read");
  const [user] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "observer@test.local",
      role_id: await builtinRoleId(srv.db, "member"),
    })
    .returning();
  if (!user) throw new Error("user fixture");
  await srv.db.update(users).set({ role_id: role.id }).where(eq(users.id, user.id));
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: user.id,
    prefix: SCOPED_KEY.slice(0, 12),
    token_sha256: createHash("sha256").update(SCOPED_KEY).digest("hex"),
    scopes: ["*"],
  });
  await grantResource(srv.db, {
    tenant_id: srv.tenantId,
    subject_type: "user",
    subject_id: user.id,
    resource_type: "workflow",
    resource_id: heldId,
    permission: "workflow:read",
  });
  scopedKey = SCOPED_KEY;
  scopedPrincipal = {
    provider: "api_key",
    kind: "user",
    id: user.id,
    tenant_id: srv.tenantId,
    roles: [],
  };
});

afterAll(async () => {
  await srv.cleanup();
});

beforeEach(() => {
  invalidateAttention();
  invalidateOperationalOverview();
});

async function get<T>(path: string, key = srv.apiKey): Promise<T> {
  const res = await fetch(`${srv.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function post(path: string): Promise<void> {
  const res = await fetch(`${srv.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${srv.apiKey}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(200);
}

async function auditRows(): Promise<number> {
  await _drainAuditWritesForTests(srv.db);
  return (await srv.db.select({ id: auditLog.id }).from(auditLog)).length;
}

const itemLine = /^- \[(stopped|failing|decide)\]/;

async function threeSurfaces(key: string, principal: ResolvedPrincipal) {
  invalidateAttention();
  const endpoint = await get<AttentionV1>("/v1/attention", key);
  invalidateAttention();
  const digest = await get<OperatorHealthDigest>("/v1/operator/health-digest", key);
  invalidateAttention();
  const summary = await buildOperatorHealthSummary(srv.db, principal);
  return {
    endpoint: endpoint.items.map((i) => i.id),
    digest: digest.attention.items.map((i) => i.id),
    summary: summary.attention.items.map((i) => i.id),
    digestLines: digest.rendered.split("\n").filter((line) => itemLine.test(line)),
    summaryLines: summary.text.split("\n").filter((line) => itemLine.test(line)),
    digestHeadline: digest.headline,
    summaryHeadline: summary.text.split("\n")[0],
  };
}

test("the endpoint returns attention.v1 for the caller", async () => {
  const body = await get<AttentionV1>("/v1/attention");
  expect(body.schema_version).toBe("attention.v1");
  expect(body.items.map((i) => [i.class, i.kind])).toEqual([
    ["stopped", "workflow"],
    ["decide", "workflow"],
  ]);
  expect(body.items[1]?.counts.patches).toBe(2);
  expect(body.status?.health_state).toBe("critical");
});

test("reading it writes no audit row", async () => {
  const before = await auditRows();
  await get<AttentionV1>("/v1/attention");
  await get<AttentionV1>("/v1/attention");
  expect(await auditRows()).toBe(before);
});

test("admin: MCP connect line, endpoint and digest block carry the same items", async () => {
  const s = await threeSurfaces(srv.apiKey, adminPrincipal(srv.tenantId, srv.userId));
  expect(s.endpoint).toEqual([`workflow:${heldId}`, `workflow:${patchedId}`]);
  expect(s.digest).toEqual(s.endpoint);
  expect(s.summary).toEqual(s.endpoint);
  expect(s.summaryLines.length).toBe(s.endpoint.length);
  expect(s.digestLines).toEqual(s.summaryLines);
  expect(s.summaryHeadline).toBe(s.digestHeadline);
  expect(s.digestHeadline).toBe("Needs attention: 2 items (1 stopped, 1 to decide).");
});

test("a reader with a grant on the held workflow only: the patched item is missing on all three", async () => {
  const s = await threeSurfaces(scopedKey, scopedPrincipal);
  expect(s.endpoint).toEqual([`workflow:${heldId}`]);
  expect(s.digest).toEqual(s.endpoint);
  expect(s.summary).toEqual(s.endpoint);
  expect(s.summaryLines).toHaveLength(1);
  expect(s.digestLines).toEqual(s.summaryLines);
  expect(s.digestHeadline).toBe("Needs attention: 1 item (1 stopped).");
});

test("a decided fix leaves the list at once — not after the cache runs out", async () => {
  const warm = await get<AttentionV1>("/v1/attention");
  expect(warm.items.map((i) => i.id)).toContain(`workflow:${patchedId}`);
  const rows = await srv.db
    .select({ id: patchCandidates.id })
    .from(patchCandidates)
    .where(eq(patchCandidates.workflow_id, patchedId));
  for (const row of rows) await post(`/v1/patch-candidates/${row.id}/reject`);
  const after = await get<AttentionV1>("/v1/attention");
  expect(after.items.map((i) => i.id)).not.toContain(`workflow:${patchedId}`);
});

test("a decided skill proposal leaves the list at once", async () => {
  const [skill] = await srv.db
    .insert(skillCandidates)
    .values({
      tenant_id: srv.tenantId,
      scope: "global",
      pattern_kind: "success_pattern",
      title: "t",
      body: "b",
      evidence: {},
      confidence: "high",
      fingerprint: "fp-attention-route",
    })
    .returning();
  invalidateAttention();
  const warm = await get<AttentionV1>("/v1/attention");
  expect(warm.items.map((i) => i.id)).toContain("skills");
  await post(`/v1/skill-candidates/${skill!.id}/reject`);
  const after = await get<AttentionV1>("/v1/attention");
  expect(after.items.map((i) => i.id)).not.toContain("skills");
});
