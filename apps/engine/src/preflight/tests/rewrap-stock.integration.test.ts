import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, getTableName, sql } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import {
  authProviderConfigs,
  chatWorkspaces,
  connectors,
  connectorTemplateCredentials,
  credentials,
  endUserCredentials,
  executionSteps,
  executions,
  subscriptions,
  tenants,
  toolApprovals,
  webhooksInbound,
  workflowRunState,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  renderVaultStockSql,
  VAULT_STOCK_INVENTORY,
  VAULT_STOCK_TABLES,
} from "../../db/vault-stock-sql.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { assertRegistryRewrapScope, RegistryRewrapScopeError } from "../rewrap-stock.ts";

const uuid = createDeterministicUuidFactory(0x570c);
const envelope = {
  ciphertext: new Uint8Array([1]),
  iv: new Uint8Array([2]),
  auth_tag: new Uint8Array([3]),
};
let ctx: TestDb;
let tenantId: string;
let workflowId: string;
let connectorId: string;
let executionId: string;

beforeAll(async () => {
  ctx = await createTestDb("rewrap-stock");
  await ctx.db.execute(sql.raw(renderVaultStockSql()));
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "stock", display_name: "Stock" })
    .returning();
  if (!tenant) throw new Error("missing tenant fixture");
  tenantId = tenant.id;
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug: "stock", name: "Stock", lifecycle: "active" })
    .returning();
  const [connector] = await ctx.db
    .insert(connectors)
    .values({ tenant_id: tenantId, slug: "stock", display_name: "Stock", driver: "http" })
    .returning();
  if (!workflow || !connector) throw new Error("missing parent fixture");
  workflowId = workflow.id;
  connectorId = connector.id;
  const [execution] = await ctx.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      status: "succeeded",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning();
  if (!execution) throw new Error("missing execution fixture");
  executionId = execution.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function present(tx: Executor) {
  const result = await tx.execute<{ present: boolean }>(
    sql`SELECT subkit.vault_non_registry_stock_present() AS present`,
  );
  return result.rows[0]?.present;
}

async function expectRefused(tx: Executor) {
  expect(await present(tx)).toBe(true);
  await expect(assertRegistryRewrapScope(tx)).rejects.toMatchObject({
    code: "vault_non_registry_stock_unsupported",
    message: new RegistryRewrapScopeError().message,
  });
}

const byteStocks = [
  {
    table: authProviderConfigs,
    seed: async (tx: Executor, id: string) => {
      await tx.insert(authProviderConfigs).values({
        id,
        tenant_id: tenantId,
        provider: "historical",
        priority: 1,
        config_iv: envelope.iv,
      });
    },
  },
  {
    table: chatWorkspaces,
    seed: async (tx: Executor, id: string) => {
      await tx.insert(chatWorkspaces).values({
        id,
        tenant_id: tenantId,
        platform: "slack",
        workspace_id: id,
        bot_ciphertext: envelope.ciphertext,
        bot_iv: envelope.iv,
        bot_auth_tag: envelope.auth_tag,
      });
    },
  },
  {
    table: connectorTemplateCredentials,
    seed: async (tx: Executor, id: string) => {
      await tx
        .insert(connectorTemplateCredentials)
        .values({ id, tenant_id: tenantId, template_slug: id, ...envelope });
    },
  },
  {
    table: credentials,
    seed: async (tx: Executor, id: string) => {
      await tx.insert(credentials).values({
        id,
        tenant_id: tenantId,
        connector_id: connectorId,
        environment: "dev",
        mode: "bearer",
        ...envelope,
        deleted_at: new Date(FROZEN_NOW),
        oauth2_refresh_ciphertext: envelope.ciphertext,
        oauth2_refresh_iv: envelope.iv,
        oauth2_refresh_auth_tag: envelope.auth_tag,
      });
    },
  },
  {
    table: endUserCredentials,
    seed: async (tx: Executor, id: string) => {
      await tx.insert(endUserCredentials).values({
        id,
        tenant_id: tenantId,
        connector_id: connectorId,
        enduser_ref: id,
        combine_mode: "replace",
        ...envelope,
      });
    },
  },
  {
    table: subscriptions,
    seed: async (tx: Executor, id: string) => {
      await tx.insert(subscriptions).values({
        id,
        tenant_id: tenantId,
        event_pattern: "execution.*",
        target_url: "https://example.test/hook",
        secret_ciphertext: envelope.ciphertext,
        secret_iv: envelope.iv,
        secret_auth_tag: envelope.auth_tag,
        rotating_secret_ciphertext: envelope.ciphertext,
        rotating_secret_iv: envelope.iv,
        rotating_secret_auth_tag: envelope.auth_tag,
      });
    },
  },
  {
    table: toolApprovals,
    seed: async (tx: Executor, id: string) => {
      await tx.insert(toolApprovals).values({
        id,
        tenant_id: tenantId,
        principal_id: uuid(),
        tool: "example",
        surface: "mcp",
        args_ciphertext: envelope.ciphertext,
        args_iv: envelope.iv,
        args_auth_tag: envelope.auth_tag,
        args_hash: "a".repeat(64),
        preview_ciphertext: envelope.ciphertext,
        preview_iv: envelope.iv,
        preview_auth_tag: envelope.auth_tag,
        expires_at: new Date(FROZEN_NOW),
      });
    },
  },
  {
    table: webhooksInbound,
    seed: async (tx: Executor, id: string) => {
      await tx.insert(webhooksInbound).values({
        id,
        tenant_id: tenantId,
        slug: id,
        workflow_id: workflowId,
        verifier: "hmac",
        secret_ciphertext: envelope.ciphertext,
        secret_iv: envelope.iv,
        secret_auth_tag: envelope.auth_tag,
      });
    },
  },
  {
    table: workflowRunState,
    seed: async (tx: Executor, id: string) => {
      await tx
        .insert(workflowRunState)
        .values({ id, tenant_id: tenantId, workflow_id: workflowId, key: id, ...envelope });
    },
  },
];

for (const stock of byteStocks) {
  test(`retained ${getTableName(stock.table)} envelope refuses settings-only rewrap`, async () => {
    await ctx.db.transaction(async (tx) => {
      const id = uuid();
      await stock.seed(tx, id);
      await expectRefused(tx);
      await tx.delete(stock.table).where(eq(stock.table.id, id));
      expect(await present(tx)).toBe(false);
      await assertRegistryRewrapScope(tx);
    });
  });
}

for (const column of ["input", "source_ref", "sensitive_result"] as const) {
  test(`sensitive executions.${column} is detected recursively`, async () => {
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(executions)
        .set({
          [column]: {
            nested: [{ $sensitive: true, ciphertext: "opaque", iv: "opaque", auth_tag: "opaque" }],
          },
        })
        .where(eq(executions.id, executionId));
      await expectRefused(tx);
      await tx
        .update(executions)
        .set({ [column]: null })
        .where(eq(executions.id, executionId));
    });
  });
}

test("sensitive step outputs and persisted request proofs are both protected", async () => {
  await ctx.db.transaction(async (tx) => {
    const id = uuid();
    await tx.insert(executionSteps).values({
      id,
      tenant_id: tenantId,
      execution_id: executionId,
      step_key: "stock",
      kind: "request",
      status: "succeeded",
      output_preview: { $sensitive: true },
    });
    await expectRefused(tx);
    await tx
      .update(executionSteps)
      .set({
        output_preview: null,
        request_meta: { extras: { prepared_request_proof: { digest: "a".repeat(64) } } },
      })
      .where(eq(executionSteps.id, id));
    await expectRefused(tx);
    await tx.delete(executionSteps).where(eq(executionSteps.id, id));
  });
});

test("persisted dispatch proofs refuse while ordinary unencrypted content remains allowed", async () => {
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(executions)
      .set({ input: { plain: "allowed", $sensitive: false } })
      .where(eq(executions.id, executionId));
    expect(await present(tx)).toBe(false);
    await assertRegistryRewrapScope(tx);
    const id = uuid();
    const [version] = await tx
      .insert(workflowVersions)
      .values({ tenant_id: tenantId, workflow_id: workflowId, version: 1, dag: {} })
      .returning({ id: workflowVersions.id });
    if (!version) throw new Error("missing dispatch workflow fixture");
    await tx.insert(executions).values({
      id,
      tenant_id: tenantId,
      status: "succeeded",
      request_source: "api",
      execution_mode: "dev",
      tool_approval_id: uuid(),
      source_kind: "saved",
      workflow_id: workflowId,
      workflow_version_id: version.id,
    });
    await tx
      .update(executions)
      .set({
        tool_approval_dispatches: {
          step: { digest: "a".repeat(64), attempts: 1, step_key: "step" },
        },
      })
      .where(eq(executions.id, id));
    await expectRefused(tx);
    await tx.delete(executions).where(eq(executions.id, id));
    expect(await present(tx)).toBe(false);
    await tx.delete(workflowVersions).where(eq(workflowVersions.id, version.id));
  });
});

test("stock inventory remains lexical and covers every fixed declared table", () => {
  expect(VAULT_STOCK_TABLES).toEqual([...VAULT_STOCK_TABLES].sort());
  expect(new Set(VAULT_STOCK_TABLES).size).toBe(VAULT_STOCK_INVENTORY.length);
});

test("scope locks freeze concurrent stock writers until the maintenance transaction ends", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = false;
  const maintenance = ctx.db.transaction(async (tx) => {
    await assertRegistryRewrapScope(tx);
    locked = true;
    await gate;
  });
  await waitFor(() => locked, { label: "stock share locks acquired", sleepMs: 5 });
  const writer = await ctx.pool.connect();
  try {
    const pid = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const id = uuid();
    const pending = writer.query(
      "INSERT INTO subkit.auth_provider_configs(id,tenant_id,provider,priority,config_iv) VALUES($1,$2,'stock',1,$3)",
      [id, tenantId, Buffer.from([1])],
    );
    await waitFor(
      async () => {
        const result = await ctx.pool.query<{ blocked: boolean }>(
          "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",
          [pid.rows[0]?.pid],
        );
        return result.rows[0]?.blocked;
      },
      { label: "stock writer waits for maintenance", sleepMs: 5 },
    );
    release();
    await maintenance;
    await pending;
    await ctx.db.transaction(expectRefused);
    await ctx.db.delete(authProviderConfigs).where(eq(authProviderConfigs.id, id));
  } finally {
    release();
    await maintenance;
    writer.release();
  }
});

test("previous schema detection never selects absent future columns", async () => {
  const previous = await createTestDb("rewrap-stock-previous", { upToIdx: 47 });
  try {
    await previous.db.transaction(assertRegistryRewrapScope);
    const columns = await previous.db.execute<{ present: boolean }>(
      sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='subkit.executions'::regclass AND attname='sensitive_result' AND NOT attisdropped) AS present`,
    );
    expect(columns.rows[0]?.present).toBe(false);
    const seeded = await previous.db.execute<{ id: string }>(
      sql`INSERT INTO subkit.tenants(slug,display_name) VALUES('historical-stock','Historical') RETURNING id`,
    );
    const tenant = seeded.rows[0];
    if (!tenant) throw new Error("missing historical tenant fixture");
    await previous.db.execute(
      sql`INSERT INTO subkit.auth_provider_configs(tenant_id,provider,priority,config_auth_tag) VALUES(${tenant.id},'historical',1,${Buffer.from([1])})`,
    );
    await expect(previous.db.transaction(assertRegistryRewrapScope)).rejects.toBeInstanceOf(
      RegistryRewrapScopeError,
    );
  } finally {
    await previous.cleanup();
  }
});
