import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
import {
  _resetConfigForTests,
  getConfig,
  installRuntimeConfig,
  loadConfig,
} from "../config/loader.ts";
import { createTestDb } from "../db/tests/setup.ts";
import { initializeModel } from "../llm/core/model-init.ts";
import { runWithTestEnv } from "../test-helpers/determinism/env.ts";
import {
  createSecretVersion,
  getRuntimeRevision,
  initializeRuntimeConfig,
  prepareRuntimeConfig,
  saveRuntimeConfigPatch,
} from "./service.ts";

test("persisted tenant provider secrets survive runtime installation and rotation", async () => {
  await runWithTestEnv({ MASTER_KEY: "11".repeat(32) }, async () => {
    const db = await createTestDb("tenant-provider");
    const directory = mkdtempSync(join(tmpdir(), "sk-tenant-provider-"));
    try {
      _resetConfigForTests();
      await loadConfig({
        env: { DATABASE_URL: db.url, NODE_ENV: "test" },
        configPathOverride: join(directory, "config.json"),
      });
      let state = await initializeRuntimeConfig(db.db, getConfig());
      for (const value of ["fixture-first-provider-key", "fixture-rotated-provider-key"]) {
        const secret = await createSecretVersion(db.db, {
          name: "fixture.tenant-provider-key",
          value,
          created_by: null,
        });
        state = await saveRuntimeConfigPatch(db.db, {
          expected_revision: state.saved_revision,
          changes: { "llm.provider": "anthropic", "llm.api_key": secret.reference },
          scope: "tenant",
          tenant_id: SYSTEM_TENANT_ID,
          created_by: null,
        });
        const revision = await getRuntimeRevision(db.db, state.saved_revision);
        expect(JSON.stringify(revision.document)).not.toContain(value);
        expect(JSON.stringify(revision.document)).toContain(secret.reference);
        const resolved = await prepareRuntimeConfig(db.db, revision);
        installRuntimeConfig(resolved);
        expect(getConfig(SYSTEM_TENANT_ID).llm.providers.anthropic.api_key).toBe(value);
        expect(getConfig().llm.providers.anthropic.api_key).toBe("");
        expect(getConfig("another-tenant").llm.providers.anthropic.api_key).toBe("");
        expect(getConfig(SYSTEM_TENANT_ID).llm.providers.openai.api_key).toBe("");
        expect((await initializeModel({ tenantId: SYSTEM_TENANT_ID })).provider).toBe("anthropic");
      }
    } finally {
      _resetConfigForTests();
      rmSync(directory, { recursive: true, force: true });
      await db.cleanup();
    }
  });
});
