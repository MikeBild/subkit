import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../auth/types.ts";
import {
  connectors,
  executionSteps,
  executions,
  patchCandidates,
  tenants,
  users,
} from "../db/schema/index.ts";
import { grantResource } from "../rbac/grants.ts";
import { readOpenPatchDecisions } from "../self-healing/open-decisions.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { reviewableDiff, seedPatchableWorkflow } from "../test-helpers/patch-candidates.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { emptyRoleId } from "../test-helpers/roles.ts";
import {
  type AttentionItem,
  attentionAllClear,
  buildAttention,
  invalidateAttention,
} from "./attention.ts";
import { HOUR, owner, tenant_id, testDb, useAttentionTenant, wf } from "./attention-fixtures.ts";
import {
  collectFailureGroups,
  DECISION_FAILURE_WINDOW_HOURS,
  failingScheduledGroups,
} from "./health-digest.ts";
import { getOperationalOverview } from "./operational-overview.ts";

useAttentionTenant();

describe("permission cost", () => {
  test("a non-admin's filter costs the same for one granted item as for ten", async () => {
    let queries = 0;
    const counted = new Set(["select", "selectDistinct", "execute", "$count"]);
    const countingDb = new Proxy(testDb.db, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (typeof prop === "string" && counted.has(prop)) queries += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });

    const [t] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-attention-cost", display_name: "Cost" })
      .returning();
    const costTenant = t!.id;
    const [u] = await testDb.db
      .insert(users)
      .values({
        tenant_id: costTenant,
        email: "cost@a",
        role_id: await emptyRoleId(testDb.db, costTenant),
      })
      .returning({ id: users.id });
    const reader: ResolvedPrincipal = {
      provider: "api_key",
      kind: "user",
      id: u!.id,
      tenant_id: costTenant,
      roles: [],
    };
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { workflow_id } = await seedPatchableWorkflow(testDb.db, costTenant, `cost-${i}`);
      ids.push(workflow_id);
      await testDb.db.insert(patchCandidates).values({
        tenant_id: costTenant,
        workflow_id,
        classification: "safe",
        status: "proposed",
        diff: reviewableDiff(`fix ${i}`),
      });
    }
    const grant = (workflowId: string) =>
      grantResource(testDb.db, {
        tenant_id: costTenant,
        subject_type: "user",
        subject_id: reader.id,
        resource_type: "workflow",
        resource_id: workflowId,
        permission: "workflow:read",
      });

    const outsideOperator = await buildAttention(testDb.db, adminPrincipal(costTenant));
    expect(outsideOperator.items.some((item) => item.id.startsWith("secret-approval:"))).toBe(
      false,
    );
    await grant(ids[0] as string);
    queries = 0;
    const one = await buildAttention(countingDb, { ...reader });
    const forOne = queries;
    expect(one.items).toHaveLength(1);

    for (const id of ids.slice(1)) await grant(id);
    queries = 0;
    const ten = await buildAttention(countingDb, { ...reader });
    const forTen = queries;
    expect(ten.items).toHaveLength(10);
    expect(forTen).toBe(forOne);
    expect(
      forTen,
      "43 permission queries, one read of the person's own snoozes and seven for knowledge sources due for review",
    ).toBeLessThanOrEqual(51);
  });
});

describe("a source that fails", () => {
  test("is reported failed, and the list is not all clear even with nothing in it", async () => {
    const [empty] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-attention-empty", display_name: "Empty" })
      .returning();
    const reader = adminPrincipal(empty!.id);
    const noSecrets = { secret_approvals: async () => [] };
    const healthy = await buildAttention(testDb.db, reader, { readers: noSecrets });
    expect(healthy.items).toEqual([]);
    expect(attentionAllClear(healthy)).toBe(true);

    const broken = await buildAttention(testDb.db, reader, {
      readers: {
        ...noSecrets,
        connections: async () => {
          throw new Error("connections unreadable");
        },
      },
    });
    expect(broken.sources.connections).toBe("failed");
    expect(broken.items).toEqual([]);
    expect(attentionAllClear(broken)).toBe(false);
  });

  test("keeps every other source's items", async () => {
    const attention = await buildAttention(testDb.db, owner, {
      readers: {
        skills: async () => {
          throw new Error("skills unreadable");
        },
      },
    });
    expect(attention.sources.skills).toBe("failed");
    expect(attention.items.map((i) => i.id)).toContain(`workflow:${wf.fail}`);
    expect(attention.items.map((i) => i.id)).not.toContain("skills");
  });
});

describe("parity with the operational overview's decision buckets", () => {
  test("every non-zero bucket has at least one item behind it", async () => {
    const overview = await getOperationalOverview(testDb.db, tenant_id);
    const { items } = await buildAttention(testDb.db, owner);
    const now = getTestNow();
    const olderThan72h = (item: AttentionItem) =>
      item.since !== null && now - Date.parse(item.since) > 72 * HOUR;

    expect(overview.core.blocked.value).toBeGreaterThan(0);
    expect(
      items.some((i) => i.class === "stopped" && i.reason.startsWith("execution_authority")),
    ).toBe(true);

    expect(overview.core.failing.value).toBeGreaterThan(0);
    expect(items.filter((i) => i.class === "failing" && i.kind === "workflow").length).toBe(
      overview.core.failing.value ?? -1,
    );

    expect(overview.core.overdue.value).toBeGreaterThan(0);
    expect(items.some((i) => i.class === "decide" && olderThan72h(i))).toBe(true);

    expect(overview.core.other_decisions.value).toBeGreaterThan(0);
    expect(
      items.some(
        (i) =>
          (i.counts.patches || i.counts.skills) &&
          i.since !== null &&
          !olderThan72h(i) &&
          (i.class === "decide" || i.class === "failing"),
      ),
    ).toBe(true);
  });

  test("each old bucket names the same workflows the attention list does", async () => {
    const overview = await getOperationalOverview(testDb.db, tenant_id);
    const { items } = await buildAttention(testDb.db, owner);
    const workflowItems = items.filter((i) => i.subject?.kind === "workflow");
    const ids = (list: AttentionItem[]) => new Set(list.map((i) => i.subject?.id));

    const held = new Set(
      overview.core.health.causes.filter((c) => c.kind === "held_schedule").map((c) => c.id),
    );
    const stopped = workflowItems.filter((i) => i.class === "stopped");
    expect(ids(stopped)).toEqual(held);
    expect(stopped.length).toBe(overview.core.blocked.value ?? -1);

    const failingGroups = failingScheduledGroups(
      await collectFailureGroups(testDb.db, tenant_id, DECISION_FAILURE_WINDOW_HOURS),
    );
    const failingWorkflows = new Set(failingGroups.map((g) => g.workflow_id ?? undefined));
    expect(ids(workflowItems.filter((i) => (i.counts.failures ?? 0) > 0))).toEqual(
      failingWorkflows,
    );
    expect(failingWorkflows.size).toBe(overview.core.failing.value ?? -1);

    const open = await readOpenPatchDecisions(testDb.db, tenant_id);
    const withPatches = workflowItems.filter((i) => (i.counts.patches ?? 0) > 0);
    expect(ids(withPatches)).toEqual(new Set(open.items.map((d) => d.row.workflow_id)));
    const patchCount = withPatches.reduce((n, i) => n + (i.counts.patches ?? 0), 0);
    const skillCount = items.find((i) => i.id === "skills")?.counts.skills ?? 0;
    expect(patchCount + skillCount).toBe(
      (overview.core.overdue.value ?? 0) + (overview.core.other_decisions.value ?? 0),
    );
  });

  test("the overview's decision drilldowns open the attention list", async () => {
    const overview = await getOperationalOverview(testDb.db, tenant_id);
    for (const metric of [
      overview.core.blocked,
      overview.core.failing,
      overview.core.overdue,
      overview.core.other_decisions,
    ]) {
      expect(metric.drilldown.path).toBe("/cockpit");
    }
    const held = overview.core.health.causes.find((c) => c.kind === "held_schedule");
    expect(held?.drilldown.path).toBe(`/cockpit?review=workflow:${wf.held}`);
    const paths = JSON.stringify(overview);
    expect(paths).not.toContain("/cockpit/decisions");
    expect(paths).not.toContain("/cockpit/operations");
  });
});

describe("a scheduled run that timed out", () => {
  test("shows its workflow as failing until a later scheduled run succeeds", async () => {
    const [t] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-attention-timeout", display_name: "Timeout" })
      .returning();
    const timeoutTenant = t!.id;
    const reader = adminPrincipal(timeoutTenant);
    const { workflow_id } = await seedPatchableWorkflow(testDb.db, timeoutTenant, "slow-one");
    const now = getTestNow();
    const [timedOut] = await testDb.db
      .insert(executions)
      .values({
        tenant_id: timeoutTenant,
        workflow_id,
        source_kind: "saved",
        status: "timed_out",
        request_source: "scheduler",
        execution_mode: "prod",
        created_at: new Date(now - 2 * HOUR),
      })
      .returning();
    await testDb.db.insert(executionSteps).values({
      tenant_id: timeoutTenant,
      execution_id: timedOut!.id,
      step_key: "read",
      step_index: 0,
      kind: "request",
      status: "timed_out",
      error: { code: "step_timeout", message: "step exceeded its timeout" },
    });

    invalidateAttention(timeoutTenant);
    const failing = await buildAttention(testDb.db, reader);
    expect(failing.sources.failures).toBe("answered");
    const item = failing.items.find((i) => i.id === `workflow:${workflow_id}`);
    expect(item?.class).toBe("failing");
    expect(item?.counts.failures).toBe(1);

    await testDb.db.insert(executions).values({
      tenant_id: timeoutTenant,
      workflow_id,
      source_kind: "saved",
      status: "succeeded",
      request_source: "scheduler",
      execution_mode: "prod",
      created_at: new Date(now - HOUR),
    });
    invalidateAttention(timeoutTenant);
    const recovered = await buildAttention(testDb.db, reader);
    expect(recovered.items.some((i) => i.id === `workflow:${workflow_id}`)).toBe(false);
  });
});

describe("a connector whose vendor retires an endpoint", () => {
  test("is a notice to decide while the endpoint works, and failing once it is gone", async () => {
    const [t] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-attention-retiring", display_name: "Retiring" })
      .returning();
    const retiringTenant = t!.id;
    const reader = adminPrincipal(retiringTenant);
    const now = getTestNow();
    const base = {
      tenant_id: retiringTenant,
      driver: "http",
      environment: "prod" as const,
      auth_type: "none" as const,
      base_url: "https://vendor.test",
      config: {},
      health_state: "needs_update",
      health_changed_at: new Date(now - HOUR),
    };
    const [retiring, soon, gone] = await testDb.db
      .insert(connectors)
      .values([
        {
          ...base,
          slug: "retiring",
          display_name: "Retiring",
          health_error_code: "endpoint_deprecated",
          health_reason: "vendor announced deprecation of an endpoint this connector uses",
          sunset_at: new Date(now + 400 * 24 * HOUR),
        },
        {
          ...base,
          slug: "soon",
          display_name: "Soon",
          health_error_code: "endpoint_deprecated",
          sunset_at: new Date(now + 10 * 24 * HOUR),
        },
        {
          ...base,
          slug: "gone",
          display_name: "Gone",
          health_error_code: "endpoint_removed",
          sunset_at: new Date(now - 24 * HOUR),
        },
      ])
      .returning();

    invalidateAttention(retiringTenant);
    const attention = await buildAttention(testDb.db, reader);
    const placed = (id: string) => {
      const entry = attention.items.find((i) => i.id === `connector:${id}`);
      return entry && { class: entry.class, severity: entry.severity, reason: entry.reason };
    };
    expect(placed(retiring!.id)).toEqual({
      class: "decide",
      severity: "notice",
      reason: "needs_update",
    });
    expect(placed(soon!.id)).toEqual({
      class: "decide",
      severity: "urgent",
      reason: "needs_update",
    });
    expect(placed(gone!.id)).toEqual({
      class: "failing",
      severity: "urgent",
      reason: "needs_update",
    });
    expect(attention.items.find((i) => i.id === `connector:${retiring!.id}`)?.deadline).toBe(
      new Date(now + 400 * 24 * HOUR).toISOString(),
    );
  });
});
