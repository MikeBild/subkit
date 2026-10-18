import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { _resetConfigForTests, loadConfig } from "../config/loader.ts";
import { listConnections, secretNames } from "../credentials/connections/index.ts";
import {
  connectors,
  conversationElicitations,
  conversations,
  credentials,
  executionSteps,
  executions,
  llmUsage,
  outboundConnections,
  patchCandidates,
  runtimeSecretVersions,
  selfHealingScans,
  skillCandidates,
  tenants,
  users,
  webhooksInbound,
  workflowsSchedules,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { currentMonthBucket } from "../llm/accounting/budget.ts";
import { resetMetricsRegistryForTests } from "../observability/metrics.ts";
import { grantResource } from "../rbac/grants.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { createSecretVersion } from "../runtime-config/service.ts";
import { readOpenPatchDecisions } from "../self-healing/open-decisions.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { reviewableDiff, seedPatchableWorkflow } from "../test-helpers/patch-candidates.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { emptyRoleId } from "../test-helpers/roles.ts";
import {
  type AttentionItem,
  attentionAllClear,
  buildAttention,
  compareAttentionItems,
  invalidateAttention,
} from "./attention.ts";
import {
  collectFailureGroups,
  DECISION_FAILURE_WINDOW_HOURS,
  failingScheduledGroups,
} from "./health-digest.ts";
import { getOperationalOverview, invalidateOperationalOverview } from "./operational-overview.ts";

const HOUR = 3600_000;
let testDb: TestDb;
let tenant_id: string;
let owner: ResolvedPrincipal;
let otherPerson: ResolvedPrincipal;
let enduser: ResolvedPrincipal;
let grantee: ResolvedPrincipal;
const wf: Record<"held" | "fail" | "auth" | "chat" | "patch", string> = {
  held: "",
  fail: "",
  auth: "",
  chat: "",
  patch: "",
};
let brokenConnectorId: string;
let connectionId: string;
let unusedConnectionId: string;
let ownConversationId: string;
let othersConversationId: string;

async function seedUser(
  email: string,
  role: "admin" | "member" | "enduser" | null,
): Promise<string> {
  const [row] = await testDb.db
    .insert(users)
    .values({
      tenant_id,
      email,
      role_id: role
        ? await builtinRoleId(testDb.db, role)
        : await emptyRoleId(testDb.db, tenant_id),
    })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture");
  return row.id;
}

async function seedScheduledFailure(
  workflow_id: string,
  error: Record<string, unknown>,
  request_meta: Record<string, unknown> | null = null,
): Promise<void> {
  const [exec] = await testDb.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id,
      source_kind: "saved",
      status: "failed",
      request_source: "scheduler",
      execution_mode: "prod",
    })
    .returning();
  if (!exec) throw new Error("execution fixture");
  await testDb.db.insert(executionSteps).values({
    tenant_id,
    execution_id: exec.id,
    step_key: "read",
    step_index: 0,
    kind: "request",
    status: "failed",
    error,
    request_meta,
  });
}

beforeAll(async () => {
  testDb = await createTestDb("operator-attention");
  const db = testDb.db;
  const now = getTestNow();

  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-attention-"));
  const configPath = join(dir, "subkit.config.json");
  writeFileSync(configPath, JSON.stringify({ tokens: { monthly_budget: 1000 } }));
  await loadConfig({
    env: { DATABASE_URL: testDb.url, NODE_ENV: "test" },
    configPathOverride: configPath,
  });
  resetMetricsRegistryForTests();

  const [tenant] = await db
    .insert(tenants)
    .values({
      slug: "t-attention",
      display_name: "Attention",
      last_connector_reauth_scan_at: new Date(now),
    })
    .returning();
  tenant_id = tenant!.id;

  const ownerId = await seedUser("owner@a", "admin");
  const otherId = await seedUser("other@a", "admin");
  const enduserId = await seedUser("enduser@a", "enduser");
  const granteeId = await seedUser("grantee@a", null);
  owner = adminPrincipal(tenant_id, ownerId);
  otherPerson = adminPrincipal(tenant_id, otherId);
  enduser = { provider: "api_key", kind: "user", id: enduserId, tenant_id, roles: ["enduser"] };
  grantee = { provider: "api_key", kind: "user", id: granteeId, tenant_id, roles: [] };

  for (const key of Object.keys(wf) as Array<keyof typeof wf>) {
    wf[key] = (await seedPatchableWorkflow(db, tenant_id, `wf-${key}`, `WF ${key}`)).workflow_id;
  }

  const [broken] = await db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "crm",
      display_name: "CRM",
      driver: "http",
      environment: "prod",
      auth_type: "none",
      base_url: "https://crm.test",
      config: {},
      health_state: "needs_reauth",
      health_reason: "token revoked",
      health_changed_at: new Date(now - 3 * HOUR),
    })
    .returning();
  brokenConnectorId = broken!.id;

  await db.insert(workflowsSchedules).values({
    tenant_id,
    workflow_id: wf.held,
    cron: "0 * * * *",
    admission_hold: {
      reason_code: "execution_authority_required",
      observed_at: new Date(now - 2 * HOUR).toISOString(),
    },
  });

  await seedScheduledFailure(wf.fail, { code: "http_5xx", message: "http 500 upstream boom" });
  await seedScheduledFailure(wf.fail, { code: "http_5xx", message: "http 500 upstream boom" });
  await db.insert(patchCandidates).values({
    tenant_id,
    workflow_id: wf.fail,
    classification: "safe",
    status: "proposed",
    diff: reviewableDiff("fix for the failing one"),
  });
  await seedScheduledFailure(
    wf.auth,
    { code: "http_4xx", message: "http 401 unauthorized" },
    { driver: "http", connector: { connector_id: brokenConnectorId } },
  );
  await seedScheduledFailure(wf.chat, { code: "http_5xx", message: "http 502 bad gateway" });
  await db.insert(patchCandidates).values({
    tenant_id,
    workflow_id: wf.patch,
    classification: "safe",
    status: "proposed",
    created_at: new Date(now - 5 * 24 * HOUR),
    diff: reviewableDiff("fix nobody asked for yet"),
  });

  const skill = {
    tenant_id,
    scope: "global" as const,
    title: "t",
    body: "b",
    evidence: {},
    confidence: "high" as const,
  };
  await db.insert(skillCandidates).values([
    { ...skill, pattern_kind: "success_pattern", fingerprint: "fp-success" },
    { ...skill, pattern_kind: "failure_pattern", status: "context", fingerprint: "fp-failure" },
  ]);

  const connectionRow = {
    tenant_id,
    base_url: "https://wiki.test",
    issuer: "https://wiki.test",
    authorization_endpoint: "https://wiki.test/authorize",
    token_endpoint: "https://wiki.test/token",
    client_id: "c",
    scopes: ["read"],
    access_token_version: 1,
  };
  const [connection] = await db
    .insert(outboundConnections)
    .values({ ...connectionRow, name: "wiki" })
    .returning();
  connectionId = connection!.id;
  await db.insert(credentials).values({
    tenant_id,
    connector_id: brokenConnectorId,
    environment: "prod",
    mode: "oauth2",
    ciphertext: Buffer.from("x"),
    iv: Buffer.from("x"),
    auth_tag: Buffer.from("x"),
    connection_id: connectionId,
  });
  const spareToken = await createSecretVersion(db, {
    name: secretNames(tenant_id, "spare").access,
    value: "spare-access-token",
    created_by: null,
  });
  const [unused] = await db
    .insert(outboundConnections)
    .values({
      ...connectionRow,
      name: "spare",
      access_token_version: spareToken.version,
      expires_at: new Date(now - HOUR),
    })
    .returning();
  unusedConnectionId = unused!.id;

  await db.insert(runtimeSecretVersions).values({
    name: "settings.llm.api_key",
    version: 2,
    ciphertext: Buffer.from("x"),
    iv: Buffer.from("x"),
    auth_tag: Buffer.from("x"),
    pending_since: new Date(now - HOUR),
  });

  await db.insert(selfHealingScans).values({
    tenant_id,
    source: "scheduler",
    filters: { tenant_id },
    status: "succeeded",
    updated_at: new Date(now - 5 * HOUR),
  });

  await db.insert(llmUsage).values({
    tenant_id,
    flow: "chat",
    model: "m",
    total_tokens: 950,
    result: "ok",
    month_bucket: currentMonthBucket(new Date(now)),
  });

  const [own] = await db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input", owner_id: ownerId, title: "Mine" })
    .returning();
  ownConversationId = own!.id;
  await db.insert(conversationElicitations).values({
    tenant_id,
    conversation_id: ownConversationId,
    tool_name: "run_workflow",
    summary: "confirm",
    input: {},
    expires_at: new Date(now + 2 * 24 * HOUR),
  });
  const [others] = await db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input", owner_id: otherId, title: "Theirs" })
    .returning();
  othersConversationId = others!.id;

  await grantResource(db, {
    tenant_id,
    subject_type: "user",
    subject_id: granteeId,
    resource_type: "workflow",
    resource_id: wf.auth,
    permission: "workflow:read",
  });
});

afterAll(async () => {
  _resetConfigForTests();
  await testDb.cleanup();
});

beforeEach(() => {
  invalidateAttention();
  invalidateOperationalOverview();
});

const byId = (items: AttentionItem[]) => new Map(items.map((item) => [item.id, item]));

describe("every source, as an admin reads it", () => {
  test("each source yields its item in its class", async () => {
    const attention = await buildAttention(testDb.db, owner);
    const items = byId(attention.items);
    const classOf = (id: string) => items.get(id)?.class;

    expect(classOf(`conversation:${ownConversationId}`)).toBe("stopped");
    expect(classOf(`workflow:${wf.held}`)).toBe("stopped");
    expect(classOf("freshness:self_healing.drift_scan")).toBe("stopped");
    expect(classOf(`workflow:${wf.fail}`)).toBe("failing");
    expect(classOf(`workflow:${wf.auth}`)).toBe("failing");
    expect(classOf(`workflow:${wf.chat}`)).toBe("failing");
    expect(classOf(`connector:${brokenConnectorId}`)).toBe("failing");
    expect(classOf(`connection:${connectionId}`)).toBe("failing");
    expect(classOf("budget")).toBe("failing");
    expect(classOf(`workflow:${wf.patch}`)).toBe("decide");
    expect(classOf("secret-approval:settings.llm.api_key@2")).toBe("decide");
    expect(classOf("skills")).toBe("decide");
    expect(items.get("skills")?.counts.skills).toBe(1);
    expect(items.get(`connection:${connectionId}`)?.reason).toBe("secret_unreadable");
    expect(items.get(`connection:${connectionId}`)?.severity).toBe("urgent");
    const spare = (await listConnections(testDb.db, tenant_id)).find(
      (view) => view.id === unusedConnectionId,
    );
    expect(spare).toMatchObject({ state: "expired", state_reason: "expired_no_refresh" });
    expect(spare?.used_by).toEqual([]);
    expect(items.has(`connection:${unusedConnectionId}`)).toBe(false);
    expect(items.get(`connector:${brokenConnectorId}`)?.actions[0]?.verb).toBe("reauth");
    expect(items.get(`workflow:${wf.held}`)?.reason).toBe("execution_authority_required");
    expect(Object.values(attention.sources).every((state) => state === "answered")).toBe(true);
    expect(attention.status?.next_run_at).toBeNull();
  });

  test("one item per workflow: failures and open fixes merge, ids are unique", async () => {
    const attention = await buildAttention(testDb.db, owner);
    const ids = attention.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const failing = byId(attention.items).get(`workflow:${wf.fail}`);
    expect(failing?.counts).toEqual({ failures: 2, consecutive_failures: 2, patches: 1 });
    expect(failing?.cause_class).toBe("driver_error");
  });

  test("the primary action follows the remedy order", async () => {
    const items = byId((await buildAttention(testDb.db, owner)).items);
    const primary = (id: string) => items.get(id)?.actions.find((a) => a.primary);
    expect(primary(`workflow:${wf.fail}`)).toMatchObject({
      verb: "review",
      href: `/cockpit?review=workflow:${wf.fail}`,
    });
    expect(primary(`workflow:${wf.held}`)?.verb).toBe("review");
    expect(primary(`workflow:${wf.auth}`)).toMatchObject({
      verb: "reauth",
      href: `/cockpit/connectors/${brokenConnectorId}`,
    });
    const chat = primary(`workflow:${wf.chat}`);
    expect(chat?.verb).toBe("chat");
    expect(chat?.href).toStartWith(`/cockpit/chat/new?workflow_id=${wf.chat}&execution_id=`);
    expect(items.get(`workflow:${wf.chat}`)?.actions.find((a) => !a.primary)).toMatchObject({
      verb: "open_runs",
      href: `/cockpit?runs=all&runs_workflow=${wf.chat}&runs_status=failed`,
    });
    expect(primary(`conversation:${ownConversationId}`)).toMatchObject({
      verb: "answer",
      href: `/cockpit/chat/${ownConversationId}`,
    });
    expect(primary(`connection:${connectionId}`)?.href).toBe(
      `/cockpit/connectors/${brokenConnectorId}`,
    );
  });

  test("ordering: stopped → failing → decide, then nearest deadline, then oldest", async () => {
    const { items } = await buildAttention(testDb.db, owner);
    expect([...items].sort(compareAttentionItems)).toEqual(items);
    const classes = items.map((item) => item.class);
    expect(classes).toEqual([...classes].sort((a, b) => rank(a) - rank(b)));
    expect(items[0]?.id).toBe(`conversation:${ownConversationId}`);
    expect(items[1]?.id).toBe("freshness:self_healing.drift_scan");
    expect(items[2]?.id).toBe(`workflow:${wf.held}`);
  });
});

function rank(klass: AttentionItem["class"]): number {
  return { stopped: 0, failing: 1, decide: 2 }[klass];
}

describe("per reader", () => {
  test("a person sees only their own waiting conversations — admins included", async () => {
    const mine = (await buildAttention(testDb.db, owner)).items.map((i) => i.id);
    expect(mine).toContain(`conversation:${ownConversationId}`);
    expect(mine).not.toContain(`conversation:${othersConversationId}`);
    const theirs = (await buildAttention(testDb.db, otherPerson)).items.map((i) => i.id);
    expect(theirs).toContain(`conversation:${othersConversationId}`);
    expect(theirs).not.toContain(`conversation:${ownConversationId}`);
  });

  test("a non-admin sees what its role reads; the rest is not_permitted, never empty", async () => {
    const attention = await buildAttention(testDb.db, enduser);
    const ids = attention.items.map((i) => i.id);
    expect(ids).toContain(`workflow:${wf.fail}`);
    expect(ids).toContain("skills");
    expect(ids).not.toContain(`connector:${brokenConnectorId}`);
    expect(ids).not.toContain("budget");
    expect(attention.sources.connectors).toBe("not_permitted");
    expect(attention.sources.connections).toBe("not_permitted");
    expect(attention.sources.secret_approvals).toBe("not_permitted");
    expect(attention.sources.freshness).toBe("not_permitted");
    expect(attention.sources.failures).toBe("answered");
    expect(attention.status).toBeNull();
  });

  test("a resource grant on one workflow shows that workflow's item and nothing else", async () => {
    const attention = await buildAttention(testDb.db, grantee);
    expect(attention.items.map((i) => i.id)).toEqual([`workflow:${wf.auth}`]);
    expect(attention.sources.failures).toBe("answered");
    expect(attention.sources.connectors).toBe("not_permitted");
    expect(attention.sources.conversations).toBe("not_permitted");
  });

  test("a key whose scopes exclude the permission reads nothing, grant or not", async () => {
    const scoped: ResolvedPrincipal = { ...grantee, scopes: ["execution:read"] };
    const attention = await buildAttention(testDb.db, scoped);
    expect(attention.items).toEqual([]);
    expect(attention.sources.failures).toBe("not_permitted");
    expect(attention.sources.patches).toBe("not_permitted");
  });

  test("without the grant the same reader is refused the source, not told it is empty", async () => {
    const stranger: ResolvedPrincipal = { ...grantee, id: "00000000-0000-4000-8000-00000000beef" };
    const attention = await buildAttention(testDb.db, stranger);
    expect(attention.items).toEqual([]);
    expect(attention.sources.failures).toBe("not_permitted");
  });
});

describe("a held webhook", () => {
  test("names its hook only to a reader who may read hooks", async () => {
    const [hook] = await testDb.db
      .insert(webhooksInbound)
      .values({
        tenant_id,
        slug: "findings-intake",
        workflow_id: wf.auth,
        verifier: "standard_webhooks",
        secret_ciphertext: Buffer.from("c"),
        secret_iv: Buffer.from("i"),
        secret_auth_tag: Buffer.from("t"),
        admission_hold: {
          reason_code: "execution_authority_required",
          observed_at: new Date(getTestNow() - HOUR).toISOString(),
        },
      })
      .returning();
    try {
      const asAdmin = await buildAttention(testDb.db, adminPrincipal(tenant_id));
      const adminItem = asAdmin.items.find((i) => i.id === `workflow:${wf.auth}`);
      expect(adminItem?.trigger).toEqual({ kind: "inbound_hook", name: "findings-intake" });
      const asGrantee = await buildAttention(testDb.db, grantee);
      const granteeItem = asGrantee.items.find((i) => i.id === `workflow:${wf.auth}`);
      expect(granteeItem?.trigger).toEqual({ kind: "inbound_hook", name: null });
    } finally {
      await testDb.db.delete(webhooksInbound).where(eq(webhooksInbound.id, hook!.id));
    }
  });
});

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

    await buildAttention(testDb.db, adminPrincipal(costTenant));
    await grant(ids[0] as string);
    queries = 0;
    const one = await buildAttention(countingDb, reader);
    const forOne = queries;
    expect(one.items).toHaveLength(1);

    for (const id of ids.slice(1)) await grant(id);
    queries = 0;
    const ten = await buildAttention(countingDb, reader);
    const forTen = queries;
    expect(ten.items).toHaveLength(10);
    expect(forTen).toBe(forOne);
    expect(forTen).toBeLessThanOrEqual(38);
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
