import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { loadConnectorSystem } from "../../connectors/system.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors, tenants, toolApprovals } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { capturePreparedWorkflowReferences } from "../../execution/prepared-workflow-references.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { consumeApproval, grantApproval, requestApproval } from "../approval.ts";
import {
  assertDirectConnectorBinding,
  captureDirectConnectorBinding,
  type DirectConnectorApproval,
  type DirectConnectorBinding,
} from "../direct-connector-binding.ts";

let testDb: TestDb;
const id = createDeterministicUuidFactory(730);
beforeAll(async () => {
  testDb = await createTestDb("direct-connector-binding");
});
afterAll(async () => {
  await testDb.cleanup();
});

async function fixture() {
  const tenant = id();
  const connectorId = id();
  const principal: ResolvedPrincipal = {
    provider: "test",
    kind: "user",
    id: id(),
    tenant_id: tenant,
    roles: ["admin"],
  };
  await testDb.db
    .insert(tenants)
    .values({ id: tenant, slug: `binding-${tenant}`, display_name: "Binding" });
  await testDb.db.insert(connectors).values({
    id: connectorId,
    tenant_id: tenant,
    slug: "bound",
    display_name: "Bound",
    driver: "http",
    auth_type: "bearer",
    environment: "dev",
    base_url: "https://connector.example.test",
  });
  const rotate = async (token: string) =>
    upsertCredential(
      {
        tenant_id: tenant,
        connector_id: connectorId,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token },
        actor_id: null,
      },
      testDb.db,
    );
  await rotate("CANARY-original-private-token");
  const args = {
    connector_id: connectorId,
    method: "POST",
    path: "/orders",
    body: { item: "book" },
  };
  const binding = await captureDirectConnectorBinding({
    db: testDb.db,
    tenant_id: tenant,
    tool: "call_connector",
    args,
  });
  if (!binding) throw new Error("fixture binding missing");
  const approvalId = id();
  await requestApproval({
    db: testDb.db,
    principal,
    approval_id: approvalId,
    tool: "call_connector",
    surface: "mcp",
    via: "mcp",
    execution_mode: "dev",
    reason: "computed_from_input",
    args,
  });
  await grantApproval({
    db: testDb.db,
    tenant_id: tenant,
    approval_id: approvalId,
    granted_by_user_id: principal.id,
    via: "portal",
  });
  const claim = await consumeApproval({
    db: testDb.db,
    principal,
    approval_id: approvalId,
    tool: "call_connector",
    surface: "mcp",
    via: "mcp",
  });
  if (!claim.ok) throw new Error("fixture claim failed");
  expect(claim.direct_connector).toEqual(binding);
  const system = await loadConnectorSystem(tenant, connectorId, "dev", testDb.db);
  if (!system) throw new Error("fixture connector missing");
  const approval: DirectConnectorApproval = {
    approval_id: approvalId,
    surface: "mcp",
    tool: "call_connector",
    binding,
  };
  const check = (bound: DirectConnectorBinding | null = binding) =>
    assertDirectConnectorBinding({
      db: testDb.db,
      tenant_id: tenant,
      principal,
      approval: { ...approval, binding: bound },
      connector: system.connector,
      credential: {
        credential_id: binding.target.credential_id,
        credential_revision: binding.target.credential_revision,
        connection_authority: binding.target.connection_authority,
      },
    });
  return { tenant, connectorId, principal, binding, approval, system, rotate, check, args };
}

describe("direct connector approval authority", () => {
  test("prepared metadata includes credential references outside request steps without exposing secrets", async () => {
    const f = await fixture();
    const definition = WorkflowDefSchema.parse({
      name: "references",
      steps: [{ id: "earlier", kind: "transform", expression: 'return "${cred.bound.token}";' }],
    });
    const first = await capturePreparedWorkflowReferences(testDb.db, f.tenant, "dev", definition);
    expect(first).toHaveLength(1);
    expect(first[0]?.credential_revision).toBe(f.binding.target.credential_revision);
    expect(first[0]?.credential_binding_digest ?? null).toBe(
      f.binding.target.credential_binding_digest,
    );
    expect(JSON.stringify(first)).not.toContain("CANARY");
    expect(await capturePreparedWorkflowReferences(testDb.db, f.tenant, "dev", definition)).toEqual(
      first,
    );
    await f.rotate("CANARY-replacement-private-token");
    await f.rotate("CANARY-original-private-token");
    expect(
      await capturePreparedWorkflowReferences(testDb.db, f.tenant, "dev", definition),
    ).not.toEqual(first);
    await expect(
      capturePreparedWorkflowReferences(testDb.db, f.tenant, "prod", definition),
    ).rejects.toMatchObject({ code: "prepared_credential_unavailable" });
    await testDb.db
      .update(connectors)
      .set({ enabled: false })
      .where(and(eq(connectors.tenant_id, f.tenant), eq(connectors.id, f.connectorId)));
    await expect(
      capturePreparedWorkflowReferences(testDb.db, f.tenant, "dev", definition),
    ).rejects.toMatchObject({ code: "prepared_credential_unavailable" });
  });
  test("unchanged credentials allow a bound call without exposing secret material", async () => {
    const f = await fixture();
    expect(await f.check()).toEqual({ redirect: "manual" });
    expect(JSON.stringify(f.binding)).not.toContain("CANARY");
  });
  test("legacy approval without metadata cannot bind itself to the current credentials", async () => {
    const f = await fixture();
    await expect(f.check(null)).rejects.toMatchObject({ code: "connector_authority_changed" });
  });
  test("rotating credentials invalidates the decision", async () => {
    const f = await fixture();
    await f.rotate("CANARY-replacement-private-token");
    await expect(f.check()).rejects.toMatchObject({ code: "connector_authority_changed" });
  });
  test("restoring the old credential value does not restore its old authority revision", async () => {
    const f = await fixture();
    await f.rotate("CANARY-replacement-private-token");
    await f.rotate("CANARY-original-private-token");
    await expect(f.check()).rejects.toMatchObject({ code: "connector_authority_changed" });
  });
  test("the actual loaded configuration must match even if the database has the approved value", async () => {
    const f = await fixture();
    await expect(
      assertDirectConnectorBinding({
        db: testDb.db,
        tenant_id: f.tenant,
        principal: f.principal,
        approval: f.approval,
        connector: { ...f.system.connector, base_url: "https://changed.example.test" },
        credential: {
          credential_id: f.binding.target.credential_id,
          credential_revision: f.binding.target.credential_revision,
          connection_authority: null,
        },
      }),
    ).rejects.toMatchObject({ code: "connector_authority_changed" });
  });
  test("the actual loaded credential generation cannot be replaced by a fresh database lookup", async () => {
    const f = await fixture();
    await expect(
      assertDirectConnectorBinding({
        db: testDb.db,
        tenant_id: f.tenant,
        principal: f.principal,
        approval: f.approval,
        connector: f.system.connector,
        credential: {
          credential_id: f.binding.target.credential_id,
          credential_revision: (f.binding.target.credential_revision ?? 0) + 1,
          connection_authority: null,
        },
      }),
    ).rejects.toMatchObject({ code: "connector_authority_changed" });
  });
  test("an approval expiring after claim cannot dispatch", async () => {
    const f = await fixture();
    await testDb.db
      .update(toolApprovals)
      .set({ expires_at: sql`clock_timestamp() - interval '1 second'` })
      .where(
        and(eq(toolApprovals.tenant_id, f.tenant), eq(toolApprovals.id, f.approval.approval_id)),
      );
    await expect(f.check()).rejects.toMatchObject({ code: "connector_authority_changed" });
  });
  test("another tenant cannot resolve the approved connector", async () => {
    const f = await fixture();
    expect(
      await captureDirectConnectorBinding({
        db: testDb.db,
        tenant_id: id(),
        tool: "call_connector",
        args: f.args,
      }),
    ).toBeNull();
  });
});
