import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  executions,
  webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { buildAttention } from "../../../operator/attention.ts";
import { getOperationalOverview } from "../../../operator/operational-overview.ts";
import { EXECUTION_RUN_QUEUE } from "../../../queue/queues.ts";
import { inboundHookAutomationView } from "../../../scheduler/workflow-automation-view.ts";
import { databaseNow } from "../../../test-helpers/database-clock.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { adminPrincipal } from "../../../test-helpers/principals.ts";
import { wasSeen } from "../dedup.ts";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const secret = "webhook-authority-integration-signing-key";
let ctx: InboundTestCtx;
let bindingId: string;
let sequence = 0;
beforeEach(async () => {
  ctx = await createInboundCtx(`authority-${++sequence}`);
  bindingId = (await ctx.createBinding({ slug: "authorized-events", verifier: "standard", secret }))
    .id;
});
afterEach(async () => {
  await ctx.cleanup();
});

function delivery(id: string, body = '{"invoice":1}', seconds = 0) {
  const timestamp = Math.floor(getTestNow() / 1000) + seconds;
  return {
    slug: "authorized-events",
    rawBody: body,
    now: timestamp * 1000,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-type": "invoice.paid",
      "webhook-signature": `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
    },
  };
}
const receive = (input: ReturnType<typeof delivery>) =>
  handleInbound({ db: ctx.db, boss: ctx.boss }, input);
const seen = (id: string) =>
  wasSeen(ctx.db, { tenant_id: ctx.tenantId, webhook_id: bindingId, standard_webhook_id: id });
async function rows() {
  return ctx.db.select().from(executions).where(eq(executions.tenant_id, ctx.tenantId));
}
async function reserved(id: string) {
  const [row] = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, ctx.tenantId),
        eq(workflowExecutionAuthorities.id, id),
      ),
    );
  return row?.reserved_runs;
}

describe("webhook execution authority admission", () => {
  test("a valid signature grants nothing; a later human grant can admit the unconsumed event", async () => {
    const input = delivery("no-authority");
    expect(await receive(input)).toMatchObject({
      status: "denied",
      reason: "execution_authority_unavailable",
    });
    expect(await rows()).toHaveLength(0);
    expect(await seen("no-authority")).toBe(false);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.reason, "execution_authority_unavailable"),
        ),
      );
    expect(audits).toHaveLength(1);
    const authority = await ctx.grantAuthority("prod", 1);
    expect(await receive(input)).toMatchObject({ status: "ok" });
    expect(await reserved(authority.id)).toBe(1);
    expect((await rows())[0]?.execution_authority_id).toBe(authority.id);
  });

  test("a hook the authority gate refuses reads as blocked until a delivery is admitted", async () => {
    const hold = async () =>
      (
        await ctx.db
          .select({ hold: webhooksInbound.admission_hold })
          .from(webhooksInbound)
          .where(
            and(eq(webhooksInbound.tenant_id, ctx.tenantId), eq(webhooksInbound.id, bindingId)),
          )
      )[0]?.hold;
    expect(await receive(delivery("refused-1"))).toMatchObject({
      status: "denied",
      reason: "execution_authority_unavailable",
    });
    const first = await hold();
    expect(first?.reason_code).toBe("execution_authority_unavailable");
    await receive(delivery("refused-2", '{"invoice":2}', 60));
    expect(await hold()).toEqual(first);

    const [status] = await inboundHookAutomationView(
      ctx.tenantId,
      ctx.workflowId,
      ctx.db,
      await databaseNow(ctx.db),
      { refusal_reasons: true },
    );
    expect(status).toMatchObject({
      inbound_hook_id: bindingId,
      slug: "authorized-events",
      state: "approval_required",
      ready: false,
      environment: "prod",
      admission_hold: first,
      last_refused_reason: "execution_authority_unavailable",
    });
    expect(status?.last_refused_at).not.toBeNull();

    const overview = await getOperationalOverview(ctx.db, ctx.tenantId);
    expect(overview.core.blocked.value).toBe(1);
    expect(
      overview.core.health.causes.filter((cause) => cause.kind === "held_inbound_hook"),
    ).toMatchObject([{ id: ctx.workflowId, reason: "held_for_review" }]);
    const { items } = await buildAttention(ctx.db, adminPrincipal(ctx.tenantId));
    expect(items.find((item) => item.id === `workflow:${ctx.workflowId}`)).toMatchObject({
      class: "stopped",
      reason: "execution_authority_unavailable",
    });

    await ctx.grantAuthority("prod", 1);
    expect(await receive(delivery("admitted", '{"invoice":3}', 120))).toMatchObject({
      status: "ok",
    });
    expect(await hold()).toBeNull();
  });

  test("development authority does not authorize a production webhook", async () => {
    const authority = await ctx.grantAuthority("dev", 1);
    expect(await receive(delivery("wrong-environment"))).toMatchObject({
      status: "denied",
      reason: "execution_authority_unavailable",
    });
    expect(await reserved(authority.id)).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  test("an expired authority cannot admit a signed delivery", async () => {
    const authority = await ctx.grantAuthority("prod", 1);
    const now = await databaseNow(ctx.db);
    await ctx.db
      .update(workflowExecutionAuthorities)
      .set({ revoked_at: now, revoked_by: authority.created_by })
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, ctx.tenantId),
          eq(workflowExecutionAuthorities.id, authority.id),
        ),
      );
    const { id: _id, created_at: _created, ...boundary } = authority;
    const [expired] = await ctx.db
      .insert(workflowExecutionAuthorities)
      .values({
        ...boundary,
        revoked_at: null,
        revoked_by: null,
        valid_from: new Date(now.getTime() - 120_000),
        valid_until: new Date(now.getTime() - 60_000),
      })
      .returning();
    if (!expired) throw new Error("expired fixture missing");
    expect(await receive(delivery("expired"))).toMatchObject({
      status: "denied",
      reason: "execution_authority_unavailable",
    });
    expect(await reserved(expired.id)).toBe(0);
    expect(await rows()).toHaveLength(0);
    expect(await seen("expired")).toBe(false);
  });

  test("concurrent distinct events cannot exceed the final available run", async () => {
    const authority = await ctx.grantAuthority("prod", 1);
    const outcomes = await Promise.all([receive(delivery("last-a")), receive(delivery("last-b"))]);
    expect(outcomes.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "denied")).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    expect(await reserved(authority.id)).toBe(1);
  });

  test("concurrent duplicate delivery creates one charged execution and one real queue job", async () => {
    const authority = await ctx.grantAuthority("prod", 1);
    const input = delivery("duplicate");
    const outcomes = await Promise.all([receive(input), receive(input), receive(input)]);
    expect(outcomes.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "deduped")).toHaveLength(2);
    expect(await rows()).toHaveLength(1);
    expect(await reserved(authority.id)).toBe(1);
    const jobs = await ctx.db.execute(
      sql`SELECT id, data FROM pgboss.job WHERE name = ${EXECUTION_RUN_QUEUE}`,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.id).toBe((await rows())[0]?.id);
  });

  test("queue failure retries the original reservation with a fresh valid delivery signature", async () => {
    const authority = await ctx.grantAuthority("prod", 1);
    const input = delivery("retry");
    const send = spyOn(ctx.boss, "send").mockRejectedValueOnce(
      new Error("queue temporarily unavailable"),
    );
    try {
      await expect(receive(input)).rejects.toThrow("queue temporarily unavailable");
    } finally {
      send.mockRestore();
    }
    expect(await seen("retry")).toBe(false);
    const original = (await rows())[0];
    expect(original?.execution_authority_id).toBe(authority.id);
    const replay = await receive(delivery("retry", input.rawBody, 60));
    expect(replay).toMatchObject({ status: "ok", execution_id: original?.id });
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]?.input).toEqual(original?.input);
    expect(await reserved(authority.id)).toBe(1);
    expect(await receive(input)).toMatchObject({ status: "deduped" });
  });

  test("a retry cannot replace the reserved event body", async () => {
    const authority = await ctx.grantAuthority("prod", 1);
    const input = delivery("changed-input");
    const send = spyOn(ctx.boss, "send").mockRejectedValueOnce(new Error("queue unavailable"));
    try {
      await expect(receive(input)).rejects.toThrow("queue unavailable");
    } finally {
      send.mockRestore();
    }
    expect(await receive(delivery("changed-input", '{"invoice":2}'))).toMatchObject({
      status: "denied",
      reason: "execution_boundary_mismatch",
    });
    expect(await seen("changed-input")).toBe(false);
    expect(await reserved(authority.id)).toBe(1);
    const jobs = await ctx.db.execute(
      sql`SELECT id FROM pgboss.job WHERE name = ${EXECUTION_RUN_QUEUE}`,
    );
    expect(jobs.rows).toHaveLength(0);
  });

  test("revocation after a failed enqueue denies retry without creating a replacement execution", async () => {
    const authority = await ctx.grantAuthority("prod", 1);
    const input = delivery("revoked");
    const send = spyOn(ctx.boss, "send").mockRejectedValueOnce(new Error("queue unavailable"));
    try {
      await expect(receive(input)).rejects.toThrow("queue unavailable");
    } finally {
      send.mockRestore();
    }
    await ctx.db
      .update(workflowExecutionAuthorities)
      .set({ revoked_at: await databaseNow(ctx.db), revoked_by: authority.created_by })
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, ctx.tenantId),
          eq(workflowExecutionAuthorities.id, authority.id),
        ),
      );
    expect(await receive(input)).toMatchObject({
      status: "denied",
      reason: "execution_authority_unavailable",
    });
    expect(await rows()).toHaveLength(1);
    expect(await reserved(authority.id)).toBe(1);
    expect(await seen("revoked")).toBe(false);
  });

  test("a replacement active version does not inherit the original authority", async () => {
    const authority = await ctx.grantAuthority("prod", 1);
    const [version] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id: ctx.workflowId,
        version: 2,
        dag: {
          name: "changed",
          version: 2,
          steps: [
            { id: "noop", kind: "transform", language: "javascript", expression: "return 2;" },
          ],
        },
      })
      .returning();
    if (!version) throw new Error("version missing");
    await ctx.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, ctx.workflowId)));
    expect(await receive(delivery("changed-version"))).toMatchObject({
      status: "denied",
      reason: "execution_authority_unavailable",
    });
    expect(await reserved(authority.id)).toBe(0);
    expect(await rows()).toHaveLength(0);
  });
});
