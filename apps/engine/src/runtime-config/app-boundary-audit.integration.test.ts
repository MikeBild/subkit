import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, like } from "drizzle-orm";
import { _resetConfigForTests, getConfig, loadConfig } from "../config/loader.ts";
import { auditLog, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { RuntimeConfigCoordinator } from "./coordinator.ts";
import {
  activateRuntimeRevision,
  getRuntimeConfigState,
  initializeRuntimeConfig,
  saveRuntimeConfigPatch,
} from "./service.ts";

let tdb: TestDb;
let configDir: string;
let actorTenant: string;
let providerTenant: string;

const bearer = {
  protocol: "oidc_bearer",
  id: "testapp-bearer",
  label: "TE-Kit",
  issuer_url: "https://issuer.example.test",
  audience: "authenticated",
  product_id: "testapp",
  tenant_slug: "boundary-provider",
  required_claims: [],
};
const apiKey = { protocol: "api_key", id: "api-key", label: "SubKit API key" };

beforeAll(async () => {
  process.env.MASTER_KEY = "55".repeat(32);
  tdb = await createTestDb("runtime-config-app-boundary");
  configDir = mkdtempSync(join(tmpdir(), "sk-app-boundary-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  await initializeRuntimeConfig(tdb.db, getConfig());
  const [actor] = await tdb.db
    .insert(tenants)
    .values({ slug: "boundary-actor", display_name: "Actor" })
    .returning();
  const [provider] = await tdb.db
    .insert(tenants)
    .values({ slug: "boundary-provider", display_name: "Provider" })
    .returning();
  if (!actor || !provider) throw new Error("tenant insert failed");
  actorTenant = actor.id;
  providerTenant = provider.id;
});

afterAll(async () => {
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  await tdb.cleanup();
});

async function saveAndActivate(changes: Record<string, unknown>) {
  const state = await getRuntimeConfigState(tdb.db);
  const saved = await saveRuntimeConfigPatch(tdb.db, {
    expected_revision: state.saved_revision,
    changes,
    scope: "global",
    created_by: null,
  });
  const activation = await activateRuntimeRevision(tdb.db, saved.saved_revision, {
    tenant_id: actorTenant,
    actor_type: "system",
    actor_id: null,
    source: "test",
  });
  return { saved, activation, previous: state.active_revision };
}

async function boundaryRows() {
  const rows = await tdb.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.resource_type, "auth_provider"), like(auditLog.action, "auth_provider.%")),
    );
  const products = await tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.resource_type, "product"), like(auditLog.action, "product.%")));
  return [...rows, ...products];
}

describe("app boundary audit on activation", () => {
  test("an active revision records provider and product changes in the right tenant", async () => {
    const coordinator = new RuntimeConfigCoordinator(tdb.db, "test", "replica-boundary");
    await coordinator.start();
    try {
      const unchanged = await saveAndActivate({ "log.level": "debug" });
      expect(unchanged.activation.activation_status).toBe("active");
      expect(await boundaryRows()).toEqual([]);

      const added = await saveAndActivate({
        "auth.providers": [apiKey, bearer],
        products: {
          testapp: {
            execution_environment: "prod",
            assistant_workflow_id: "00000000-0000-4000-8000-0000000000a1",
            budget_bucket: "brain",
          },
        },
      });
      expect(added.activation.activation_status).toBe("active");
      const rows = await boundaryRows();
      expect(rows.map((row) => [row.action, row.tenant_id, row.resource_id]).sort()).toEqual(
        [
          ["auth_provider.added", providerTenant, "testapp-bearer"],
          ["product.added", actorTenant, "testapp"],
        ].sort(),
      );
      const provider = rows.find((row) => row.action === "auth_provider.added");
      expect(provider?.metadata).toMatchObject({
        provider_id: "testapp-bearer",
        protocol: "oidc_bearer",
        issuer_url: "https://issuer.example.test",
        product_id: "testapp",
        revision: added.saved.saved_revision,
        previous_revision: added.previous,
        source: "test",
      });

      await saveAndActivate({
        "auth.providers": [apiKey, { ...bearer, audience: "rotated-audience" }],
      });
      const changed = (await boundaryRows()).find((row) => row.action === "auth_provider.changed");
      expect(changed?.metadata).toMatchObject({ changed_fields: ["audience"] });
      expect(JSON.stringify(changed)).not.toContain("rotated-audience");
    } finally {
      await coordinator.stop();
    }
  });

  test("a restart-required revision records nothing until it becomes active", async () => {
    const before = (await boundaryRows()).length;
    const state = await getRuntimeConfigState(tdb.db);
    const saved = await saveRuntimeConfigPatch(tdb.db, {
      expected_revision: state.saved_revision,
      changes: { "server.port": 3011, products: {} },
      scope: "global",
      created_by: null,
    });
    const activation = await activateRuntimeRevision(tdb.db, saved.saved_revision, {
      tenant_id: actorTenant,
      actor_type: "system",
      actor_id: null,
      source: "test",
    });
    expect(activation.activation_status).toBe("restart_required");
    expect((await boundaryRows()).length).toBe(before);

    await initializeRuntimeConfig(tdb.db, getConfig(), { maxWaitMs: 0 });
    const removed = (await boundaryRows()).filter((row) => row.action === "product.removed");
    expect(removed).toEqual([
      expect.objectContaining({
        resource_id: "testapp",
        actor_type: "system",
        metadata: expect.objectContaining({ source: "boot", revision: saved.saved_revision }),
      }),
    ]);
  });
});
