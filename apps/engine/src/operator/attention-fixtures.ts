import { afterAll, beforeAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { _resetConfigForTests, loadConfig } from "../config/loader.ts";
import { secretNames } from "../credentials/connections/index.ts";
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
  workflowsSchedules,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { currentMonthBucket } from "../llm/accounting/budget.ts";
import { resetMetricsRegistryForTests } from "../observability/metrics.ts";
import { grantResource } from "../rbac/grants.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { createSecretVersion } from "../runtime-config/service.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { reviewableDiff, seedPatchableWorkflow } from "../test-helpers/patch-candidates.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { emptyRoleId } from "../test-helpers/roles.ts";
import { invalidateAttention } from "./attention.ts";
import { invalidateOperationalOverview } from "./operational-overview.ts";

export const HOUR = 3600_000;

export let testDb: TestDb;

export let tenant_id: string;

export let owner: ResolvedPrincipal;

export let otherPerson: ResolvedPrincipal;

export let enduser: ResolvedPrincipal;

export let grantee: ResolvedPrincipal;

export const wf: Record<"held" | "fail" | "auth" | "chat" | "patch", string> = {
  held: "",
  fail: "",
  auth: "",
  chat: "",
  patch: "",
};

export let brokenConnectorId: string;

export let connectionId: string;

export let unusedConnectionId: string;

export let ownConversationId: string;

export let othersConversationId: string;

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

export function useAttentionTenant(): void {
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
        is_operator: true,
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
}
