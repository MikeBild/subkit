import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig } from "../../../config/loader.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import type { ToolContext } from "../index.ts";

export let ctx: TestDb;
export let tenant_id: string;

export async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-dry-run-transform-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/dry-run-transform",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

export function makeCtx(): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

export function useDryRunTransformSetup(): void {
  beforeAll(async () => {
    await ensureConfigLoaded();
    ctx = await createTestDb("dry_run_transform");
    tenant_id = (await seedTenant(ctx.db, { slug: "t-drt", display_name: "T" })).id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });
}
