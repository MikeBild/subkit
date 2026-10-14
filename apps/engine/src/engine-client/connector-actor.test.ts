import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createConnector } from "../connectors/service.ts";
import { auditLog, tenants, workflows } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { engineClientActorType } from "../llm/accounting/actor.ts";
import { EngineClient } from "./index.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb("engine_client_connector_actor");
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("EngineClient connector actor provenance", () => {
  test("update and delete retain the system-account actor in persisted audit rows", async () => {
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "engine-client-connector-actor", display_name: "Engine client actor" })
      .returning();
    if (!tenant) throw new Error("tenant insert returned no row");

    const updatedConnector = await createConnector(
      {
        tenant_id: tenant.id,
        input: {
          name: "Update target",
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: "https://update.example.test",
        },
        actor_id: null,
        actor: null,
      },
      testDb.db,
    );
    const deletedConnector = await createConnector(
      {
        tenant_id: tenant.id,
        input: {
          name: "Delete target",
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: "https://delete.example.test",
        },
        actor_id: null,
        actor: null,
      },
      testDb.db,
    );
    const unknownUpdatedConnector = await createConnector(
      {
        tenant_id: tenant.id,
        input: {
          name: "Unknown update target",
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: "https://unknown-update.example.test",
        },
        actor_id: null,
        actor: null,
      },
      testDb.db,
    );
    const unknownDeletedConnector = await createConnector(
      {
        tenant_id: tenant.id,
        input: {
          name: "Unknown delete target",
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: "https://unknown-delete.example.test",
        },
        actor_id: null,
        actor: null,
      },
      testDb.db,
    );
    const legacyActorConnector = await createConnector(
      {
        tenant_id: tenant.id,
        input: {
          name: "Legacy actor target",
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: "https://legacy-actor.example.test",
        },
        actor_id: null,
        actor: null,
      },
      testDb.db,
    );
    const systemAccountId = "20000000-0000-4000-8000-000000000001";
    const client = new EngineClient({
      tenant_id: tenant.id,
      actor_id: systemAccountId,
      actor_type: "system_account",
      db: testDb.db,
    });

    await client.connectors.update(updatedConnector.id, { name: "Updated target" });
    await client.connectors.delete(deletedConnector.id);
    const unknownClient = new EngineClient({
      tenant_id: tenant.id,
      actor_id: null,
      actor_type: "unknown",
      db: testDb.db,
    });
    await unknownClient.connectors.update(unknownUpdatedConnector.id, {
      name: "Unknown updated target",
    });
    await unknownClient.connectors.delete(unknownDeletedConnector.id);
    const legacyActorId = "20000000-0000-4000-8000-000000000002";
    const legacyClient = new EngineClient({
      tenant_id: tenant.id,
      actor_id: legacyActorId,
      actor_type: engineClientActorType(null, legacyActorId),
      db: testDb.db,
    });
    await legacyClient.connectors.update(legacyActorConnector.id, {
      name: "Legacy actor updated",
    });

    const rows = await testDb.db
      .select({
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        action: auditLog.action,
        resource_id: auditLog.resource_id,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant.id),
          inArray(auditLog.resource_id, [
            updatedConnector.id,
            deletedConnector.id,
            unknownUpdatedConnector.id,
            unknownDeletedConnector.id,
            legacyActorConnector.id,
          ]),
        ),
      );
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          actor_type: "system_account",
          actor_id: systemAccountId,
          action: "connector.updated",
          resource_id: updatedConnector.id,
        },
        {
          actor_type: "system_account",
          actor_id: systemAccountId,
          action: "connector.deleted",
          resource_id: deletedConnector.id,
        },
        {
          actor_type: "unknown",
          actor_id: null,
          action: "connector.updated",
          resource_id: unknownUpdatedConnector.id,
        },
        {
          actor_type: "unknown",
          actor_id: null,
          action: "connector.deleted",
          resource_id: unknownDeletedConnector.id,
        },
        {
          actor_type: "unknown",
          actor_id: null,
          action: "connector.updated",
          resource_id: legacyActorConnector.id,
        },
      ]),
    );
  });

  test("workflow update and delete preserve a typed actor in persisted audits", async () => {
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "engine-client-workflow-actor", display_name: "Workflow actor" })
      .returning();
    if (!tenant) throw new Error("tenant insert returned no row");
    const [updatedWorkflow, deletedWorkflow] = await testDb.db
      .insert(workflows)
      .values([
        {
          tenant_id: tenant.id,
          slug: "engine-client-workflow-update",
          name: "Before update",
          lifecycle: "draft",
        },
        {
          tenant_id: tenant.id,
          slug: "engine-client-workflow-delete",
          name: "Before delete",
          lifecycle: "draft",
        },
      ])
      .returning();
    if (!updatedWorkflow || !deletedWorkflow) throw new Error("workflow insert returned no rows");

    const systemAccountId = "20000000-0000-4000-8000-000000000002";
    const client = new EngineClient({
      tenant_id: tenant.id,
      actor_id: systemAccountId,
      actor_type: "system_account",
      db: testDb.db,
    });
    await client.workflows.update({ id: updatedWorkflow.id, name: "Updated workflow" });
    await client.workflows.delete(deletedWorkflow.id);

    const rows = await testDb.db
      .select({
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        action: auditLog.action,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant.id),
          inArray(auditLog.resource_id, [updatedWorkflow.id, deletedWorkflow.id]),
        ),
      );
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          actor_type: "system_account",
          actor_id: systemAccountId,
          action: "workflow.updated",
        },
        {
          actor_type: "system_account",
          actor_id: systemAccountId,
          action: "workflow.deleted",
        },
      ]),
    );
  });
});
