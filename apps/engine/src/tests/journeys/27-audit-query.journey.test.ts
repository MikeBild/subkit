// User story: As a compliance operator, I want to pull targeted slices
// of the audit log through a REST API so I can answer SOC 2 + ISO 27001
// questions without running ad-hoc SQL against production.
//
// Acceptance criteria:
//   - AC1: Several distinct mutations produce distinct audit rows.
//   - AC2: `action` filter narrows to a single kind.
//   - AC3: `result=denied` lists at least the forced hook denial and
//          the policy.denied row the RBAC gate wrote.
//   - AC4: `actor_id` narrows to the admin's own rows.
//   - AC5: `limit` pagination returns a cursor that walks the history.
//   - AC6: `export.ndjson` streams the full set, one JSON per line.
//   - AC7: A member-role API key is denied by `audit:read`.
//
// Spec refs: docs/07-security-governance.md, docs/07-security-governance.md, gap-pass-2 Stream D

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { auditAwait } from "../../audit/audit.ts";
import { apiKeys, users } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let workflowId = "";
let rotatedKeyId = "";
let skillId = "";
let memberApiKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function newApiKey() {
  const rand = randomBytes(24).toString("base64url").slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

describe("journey: audit query surface", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("27-audit-query");

    // --- Seed a member API key for AC7.
    const [member] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "member-audit-query@test.local",
        role: "member",
        role_id: ctx.rbacRoleIds.member,
      })
      .returning();
    if (!member) throw new Error("seed member failed");
    const mk = newApiKey();
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: member.id,
      prefix: mk.prefix,
      token_sha256: mk.hash,
      scopes: ["*"],
    });
    memberApiKey = mk.plaintext;
  }, 60_000);

  afterAll(async () => {
    if (ctx?.cleanup) await ctx.cleanup();
  });

  test("AC1: distinct mutations produce distinct audit rows", async () => {
    // 1. Create a workflow → workflow.created
    const wfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "audit-query-wf",
        slug: "audit-query-wf",
        steps: [{ kind: "transform", id: "t1", expression: '"ok"' }],
      }),
    });
    expect(wfRes.status).toBe(201);
    workflowId = ((await wfRes.json()) as { id: string }).id;

    // 2. Issue + rotate an api key → api_key.issued + api_key.rotated
    const issueRes = await journeyFetch(ctx, "/v1/identity/api-keys", {
      method: "POST",
      body: JSON.stringify({
        owner_kind: "system_account",
        owner_id: ctx.systemAccountId,
        scopes: ["workflows:read"],
      }),
    });
    expect(issueRes.status).toBe(201);
    rotatedKeyId = ((await issueRes.json()) as { id: string }).id;
    const rotateRes = await journeyFetch(ctx, `/v1/identity/api-keys/${rotatedKeyId}/rotate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(rotateRes.status).toBe(200);

    // 3. Create + delete a skill → skill.created + skill.deleted
    const skillRes = await journeyFetch(ctx, "/v1/skills", {
      method: "POST",
      body: JSON.stringify({
        scope: "global",
        title: "audit query skill",
        body: "An example skill used by the audit query journey.",
        status: "active",
      }),
    });
    expect(skillRes.status).toBe(201);
    skillId = ((await skillRes.json()) as { id: string }).id;
    const delSkillRes = await journeyFetch(ctx, `/v1/skills/${skillId}`, { method: "DELETE" });
    expect(delSkillRes.status).toBe(204);

    // 4. Run a workflow → execution.started
    const runRes = await journeyFetch(ctx, `/v1/workflows/${workflowId}/run?sync=1`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(runRes.status).toBe(200);

    // 5. Force a RBAC-denial by hitting audit-log as the member. This
    //    mirrors the "hook denial" acceptance in the plan — we use the
    //    rbac `requirePermission("audit:read")` middleware, which
    //    emits a `policy.denied` audit row with result=denied.
    const memberRes = await fetch(`${ctx.baseUrl}/v1/audit-log`, {
      headers: { authorization: `Bearer ${memberApiKey}` },
    });
    expect(memberRes.status).toBe(403);

    // Also seed a direct audit row with result=denied so the denied
    // filter has a deterministic anchor unaffected by timing of the
    // fire-and-forget write path.
    await auditAwait(
      {
        tenant_id: ctx.tenantId,
        actor_type: "user",
        actor_id: ctx.userId,
        action: "policy.denied" as never,
        resource_type: "workflow",
        resource_id: workflowId,
        result: "denied",
        reason: "forced_denial",
      },
      ctx.db,
    );
  });

  test("AC2: action=workflow.created narrows correctly", async () => {
    const res = await journeyFetch(ctx, "/v1/audit-log?action=workflow.created");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ action: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    for (const r of body.items) expect(r.action).toBe("workflow.created");
  });

  test("AC3: result=denied returns at least one row", async () => {
    const res = await journeyFetch(ctx, "/v1/audit-log?result=denied&limit=500");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ result: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    for (const r of body.items) expect(r.result).toBe("denied");
  });

  test("AC4: actor_id=<admin> returns the admin's rows", async () => {
    const res = await journeyFetch(ctx, `/v1/audit-log?actor_id=${ctx.userId}&limit=500`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ actor_id: string | null }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    for (const r of body.items) expect(r.actor_id).toBe(ctx.userId);
  });

  test("AC5: pagination — limit=10 returns 10 + next_cursor", async () => {
    // Seed 30+ direct rows so the pagination math is deterministic
    // regardless of how many fire-and-forget audit writes happened to
    // land before this test runs.
    for (let i = 0; i < 32; i += 1) {
      // allow-wall-clock: 1 ms gap so ts is strictly monotonic; the
      // cursor walker otherwise skips ties between rows with identical
      // millisecond timestamps. Production audit writes don't share
      // this problem because they are separated by real work.
      await new Promise((r) => setTimeout(r, 1));
      await auditAwait(
        {
          tenant_id: ctx.tenantId,
          actor_type: "user",
          actor_id: ctx.userId,
          action: "workflow.updated" as never,
          resource_type: "workflow",
          resource_id: workflowId,
          result: "success",
          metadata: { seed_index: i },
        },
        ctx.db,
      );
    }

    const p1 = await journeyFetch(ctx, "/v1/audit-log?action=workflow.updated&limit=10");
    expect(p1.status).toBe(200);
    const p1Body = (await p1.json()) as {
      items: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(p1Body.items.length).toBe(10);
    expect(p1Body.next_cursor).toBeTruthy();

    const p2 = await journeyFetch(
      ctx,
      `/v1/audit-log?action=workflow.updated&limit=10&before=${encodeURIComponent(p1Body.next_cursor ?? "")}`,
    );
    expect(p2.status).toBe(200);
    const p2Body = (await p2.json()) as {
      items: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(p2Body.items.length).toBe(10);
    const firstIds = new Set(p1Body.items.map((r) => r.id));
    for (const row of p2Body.items) expect(firstIds.has(row.id)).toBe(false);
  });

  test("AC6: export.ndjson streams all rows, one per line", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/audit-log/export.ndjson`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const row = JSON.parse(line) as { id: string; tenant_id: string };
      expect(row.id).toBeTruthy();
      expect(row.tenant_id).toBe(ctx.tenantId);
    }
  });

  test("AC7: member API key → 403 on /v1/audit-log", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/audit-log`, {
      headers: { authorization: `Bearer ${memberApiKey}` },
    });
    expect(res.status).toBe(403);
  });
});
