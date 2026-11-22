import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, getConfig, loadConfig } from "../config/loader.ts";
import { runtimeSecretVersions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { type SeededRoleIds, seedBuiltinRolesAndPermissions } from "../rbac/seed.ts";
import { RuntimeConfigCoordinator } from "../runtime-config/coordinator.ts";
import {
  getRuntimeConfigState,
  getRuntimeRevision,
  initializeRuntimeConfig,
} from "../runtime-config/service.ts";
import { testEnv } from "../test-helpers/determinism/env.ts";
import { _resetRateLimitForTests, consume, run } from "./bootstrap.ts";

let tdb: TestDb;
let rbacIds: SeededRoleIds;
let configDir: string;
let coordinator: RuntimeConfigCoordinator;

beforeAll(async () => {
  testEnv.MASTER_KEY = "66".repeat(32);
  tdb = await createTestDb("onboarding_bootstrap_global_llm");
  rbacIds = await seedBuiltinRolesAndPermissions(tdb.db);
  configDir = mkdtempSync(join(tmpdir(), "subkit-bootstrap-global-llm-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  await initializeRuntimeConfig(tdb.db, getConfig());
  coordinator = new RuntimeConfigCoordinator(tdb.db, "test", "bootstrap-global-llm-replica");
  await coordinator.start();
  _resetRateLimitForTests();
});

afterAll(async () => {
  await coordinator.stop();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  await tdb.cleanup();
});

describe("first-run setup with runtime configuration", () => {
  test("the first workspace's LLM also becomes the global default", async () => {
    expect(getConfig().llm.provider).toBe("mock");
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    const outcome = await consume(
      tdb.db,
      rbacIds,
      {
        admin_email: "ops@example.com",
        tenant_name: "Global Default",
        llm_provider: "openai",
        llm_api_key: "sk-openai-test-key",
      },
      {
        token: minted.plaintext_token!,
        probe: async () => ({ ok: true as const, model: "probe-model" }),
      },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;

    const names = (await tdb.db.select().from(runtimeSecretVersions)).map((row) => row.name);
    expect(names).toContain(`tenants.${outcome.tenant_id}.settings.llm.api_key`);
    expect(names).toContain("settings.llm.api_key");
    const state = await getRuntimeConfigState(tdb.db);
    const active = await getRuntimeRevision(tdb.db, state.active_revision);
    const document = active.document as {
      llm?: { provider?: string; api_key?: string };
      tenants?: Record<string, { llm?: { provider?: string } }>;
    };
    expect(document.llm?.provider).toBe("openai");
    expect(document.llm?.api_key).toStartWith("secret://");
    expect(document.tenants?.[outcome.tenant_id]?.llm?.provider).toBe("openai");
  });
});
