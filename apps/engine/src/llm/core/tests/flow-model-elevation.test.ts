import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig } from "../../../config/loader.ts";
import { tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { resetMockProvider } from "../../mock-provider.ts";
import type { LlmFlow, ModelRoute } from "../../types.ts";
import { applyFlowEnvOverrides, applyFlowModelElevation, invoke } from "../invoke.ts";

const BASE_ROUTE: ModelRoute = {
  tenant_id: "00000000-0000-0000-0000-000000000000",
  primary: "claude-haiku-4-5",
  fallback: "claude-sonnet-4-6",
  provider: "anthropic",
  fallback_provider: "anthropic",
  context_cap: 200_000,
  monthly_budget: null,
};

const ENV_KEYS = ["JUDGE_MODEL", "GENERATE_MODEL", "CONVERSE_MODEL"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const v = savedEnv[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
});

describe("applyFlowModelElevation", () => {
  test("judge → primary elevated to the fallback model", () => {
    const out = applyFlowModelElevation(BASE_ROUTE, "judge");
    expect(out.primary).toBe("claude-sonnet-4-6");
    expect(out.provider).toBe(BASE_ROUTE.fallback_provider);
    expect(out.fallback).toBe("claude-haiku-4-5");
    expect(out.fallback_provider).toBe(BASE_ROUTE.provider);
  });

  test("generate → primary elevated to the fallback model", () => {
    const out = applyFlowModelElevation(BASE_ROUTE, "generate");
    expect(out.primary).toBe("claude-sonnet-4-6");
  });

  test("all other flows → route unchanged", () => {
    const flows: LlmFlow[] = [
      "extract",
      "repair",
      "converse",
      "discover",
      "summarize",
      "suggest_next",
      "critic_authoring",
    ];
    for (const flow of flows) {
      const out = applyFlowModelElevation(BASE_ROUTE, flow);
      expect(out).toBe(BASE_ROUTE);
    }
  });

  test("no distinct fallback configured → primary kept unchanged", () => {
    const sameModel: ModelRoute = {
      ...BASE_ROUTE,
      fallback: BASE_ROUTE.primary,
    };
    expect(applyFlowModelElevation(sameModel, "judge")).toBe(sameModel);
    expect(applyFlowModelElevation(sameModel, "generate")).toBe(sameModel);
    const emptyFallback: ModelRoute = { ...BASE_ROUTE, fallback: "" };
    expect(applyFlowModelElevation(emptyFallback, "judge")).toBe(emptyFallback);
  });

  test("env override still wins ON TOP of the elevation (invoke composition order)", () => {
    process.env.GENERATE_MODEL = "operator-pinned-model";
    const out = applyFlowEnvOverrides(applyFlowModelElevation(BASE_ROUTE, "generate"), "generate");
    expect(out.primary).toBe("operator-pinned-model");
  });
});

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-elevation-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/elevation-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

const skip = process.env.REQUIRES_PG === "0";
let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  if (skip) return;
  await ensureConfigLoaded();
  testDb = await createTestDb("flow_model_elevation");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "elevation", display_name: "Elevation" })
    .returning();
  tenant_id = tenant!.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

function mockRoute(overrides: Partial<ModelRoute> = {}): ModelRoute {
  return {
    ...BASE_ROUTE,
    tenant_id,
    provider: "mock",
    fallback_provider: "mock",
    ...overrides,
  };
}

describe.skipIf(skip)("invoke · flow model elevation (mock provider)", () => {
  beforeEach(() => {
    resetMockProvider();
  });

  test("judge flow runs on the fallback model id", async () => {
    const res = await invoke(
      {
        flow: "judge",
        tenant_id,
        user_turns: [{ role: "user", content: "judge this preview" }],
        route: mockRoute(),
      },
      testDb.db,
    );
    expect(res.model_used).toBe("claude-sonnet-4-6");
    expect(res.fell_back).toBe(false);
  });

  test("generate flow runs on the fallback model id", async () => {
    const res = await invoke(
      {
        flow: "generate",
        tenant_id,
        user_turns: [{ role: "user", content: "generate a workflow" }],
        route: mockRoute(),
      },
      testDb.db,
    );
    expect(res.model_used).toBe("claude-sonnet-4-6");
  });

  test("converse flow stays on the primary model", async () => {
    const res = await invoke(
      {
        flow: "converse",
        tenant_id,
        user_turns: [{ role: "user", content: "hello" }],
        route: mockRoute(),
      },
      testDb.db,
    );
    expect(res.model_used).toBe("claude-haiku-4-5");
  });

  test("no-fallback route → judge stays on the primary model", async () => {
    const res = await invoke(
      {
        flow: "judge",
        tenant_id,
        user_turns: [{ role: "user", content: "judge this preview" }],
        route: mockRoute({ fallback: "claude-haiku-4-5" }),
      },
      testDb.db,
    );
    expect(res.model_used).toBe("claude-haiku-4-5");
  });
});
