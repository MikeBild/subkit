// Bounded JSONata auto-repair (Fix 10).
//
//   - fixes a known-bad expression (`:=` misuse) within ≤2 attempts and
//     marks `repaired: true` with before/after,
//   - verifies empty-result repairs against the RECORDED scope (a
//     candidate that compiles but still extracts nothing is rejected),
//   - gives up cleanly after 2 attempts (`repaired: false`, last_error),
//   - rides the dry_run_transform failure path.
//
// The PROPOSE-only "repair rides the tool envelope, draft unchanged"
// contract is exercised at the pipeline layer (author_workflow runs
// runRecordedEval with repair armed); see recorded-eval.test.ts.
//
// LLM provider is the in-process mock (LLM_PROVIDER=mock bootstrap +
// `generateOverrides.repair`) — no network, deterministic.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getConfig, loadConfig } from "../../config/loader.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import { dryRunTransformTool } from "../tools/dry-run-transform.ts";
import type { ToolContext } from "../tools/index.ts";
import { MAX_REPAIR_ATTEMPTS, repairTransformExpression } from "../transform-repair.ts";

const nextUuid = createDeterministicUuidFactory(0xf18_10);

let ctx: TestDb;
let tenant_id: string;

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    /* fall through */
  }
  // Bootstrap config with `LLM_PROVIDER=mock` so the provider registry
  // selects the in-process mock — the bootstrap env channel documented
  // in env.ts, not a feature flag.
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-transform-repair-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/transform-repair",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  await ensureConfigLoaded();
  ctx = await createTestDb("transform_repair");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-repair", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
});

const RECORDED_SCOPE: Record<string, unknown> = {
  fetch: { data: { items: [{ name: "Ada" }, { name: "Grace" }] }, duration_ms: 1, error: null },
};

describe("repairTransformExpression — bounded repair mechanics", () => {
  test("fixes a syntax error (compile error) on the first attempt with before/after", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "const items = input.scope.fetch.data.items; return items;",
      reasoning: "a transform body must be valid JavaScript with an explicit return",
    });
    const bad = "const items = ; return items;";
    const outcome = await repairTransformExpression({
      expression: bad,
      finding: { kind: "compile_error", message: "Unexpected token ';'" },
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(1);
    expect(outcome.before).toBe(bad);
    expect(outcome.after).toBe("const items = input.scope.fetch.data.items; return items;");
    expect(outcome.expression).toBe(outcome.after);
  });

  test("empty-result repair: a still-empty candidate is rejected mechanically, the second verified attempt wins", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.repair = () => {
      calls += 1;
      return calls === 1
        ? { expression: "return input.scope.fetch.data.nope;" } // parses, still empty
        : { expression: "return input.scope.fetch.data.items;" }; // non-empty against recorded scope
    };
    const outcome = await repairTransformExpression({
      expression: "return input.scope.fetch.data.wrong_field;",
      finding: { kind: "empty_result", message: "expression evaluated to an empty result" },
      scopeSample: RECORDED_SCOPE,
      pathCandidates: ["input.scope.fetch.data.items"],
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(2);
    expect(outcome.after).toBe("return input.scope.fetch.data.items;");
    expect(calls).toBe(2);
  });

  test("gives up cleanly after the attempt bound with repaired:false + last_error", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "return input.scope.fetch.data.still_wrong;",
    });
    const outcome = await repairTransformExpression({
      expression: "return input.scope.fetch.data.wrong_field;",
      finding: { kind: "empty_result", message: "expression evaluated to an empty result" },
      scopeSample: RECORDED_SCOPE,
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(false);
    if (outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(MAX_REPAIR_ATTEMPTS);
    expect(outcome.last_error.length).toBeGreaterThan(0);
  });
});

describe("dry_run_transform — repair rides the failure path", () => {
  function makeCtx(): ToolContext {
    return {
      db: ctx.db,
      tenant_id,
      conversation_id: nextUuid(),
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
      getDraft: () => createEmptyDraftDocument(),
      setDraft: async () => {},
    };
  }

  test("empty result over a real scope attaches a verified repair proposal (nothing persisted)", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "$scope.fetch.data.items",
    });
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "$scope.fetch.data.wrong_field",
      sample_data: RECORDED_SCOPE,
      dialect: "jsonata",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      persistence: string;
      value: unknown;
      repair?: { repaired: boolean; after?: string; before?: string };
    };
    expect(data.persistence).toBe("none");
    expect(data.repair?.repaired).toBe(true);
    expect(data.repair?.before).toBe("$scope.fetch.data.wrong_field");
    expect(data.repair?.after).toBe("$scope.fetch.data.items");
  });

  test("syntax error attaches a repair; a clean evaluation attaches none", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "( $x := $scope.fetch.data.items; $x )",
    });
    const broken = await dryRunTransformTool.execute(makeCtx(), {
      expression: "x := $scope.fetch.data.items",
      sample_data: RECORDED_SCOPE,
      dialect: "jsonata",
    });
    expect(broken.ok).toBe(false);
    const brokenData = broken.data as { repair?: { repaired: boolean } };
    expect(brokenData.repair?.repaired).toBe(true);

    const clean = await dryRunTransformTool.execute(makeCtx(), {
      expression: "$scope.fetch.data.items",
      sample_data: RECORDED_SCOPE,
      dialect: "jsonata",
    });
    expect(clean.ok).toBe(true);
    expect((clean.data as { repair?: unknown }).repair).toBeUndefined();
  });
});
