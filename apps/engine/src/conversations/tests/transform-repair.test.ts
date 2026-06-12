// Bounded JSONata auto-repair (Fix 10).
//
//   - fixes a known-bad expression (`:=` misuse) within ≤2 attempts and
//     marks `repaired: true` with before/after,
//   - verifies empty-result repairs against the RECORDED scope (a
//     candidate that compiles but still extracts nothing is rejected),
//   - gives up cleanly after 2 attempts (`repaired: false`, last_error),
//   - is PROPOSE-only: a build_workflow whose recorded-eval carried a
//     repair leaves the draft byte-identical to what the model sent,
//   - rides the dry_run_transform failure path.
//
// LLM provider is the in-process mock (LLM_PROVIDER=mock bootstrap +
// `generateOverrides.repair`) — no network, deterministic.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig } from "../../config/loader.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import type { RecordedEvalReport } from "../recorded-eval.ts";
import { stepFingerprint } from "../step-fingerprint.ts";
import { buildWorkflowTool } from "../tools/build-workflow.ts";
import { dryRunTransformTool } from "../tools/dry-run-transform.ts";
import type { ToolContext } from "../tools/index.ts";
import { MAX_REPAIR_ATTEMPTS, repairTransformExpression } from "../transform-repair.ts";
import type { DraftDocument } from "../types.ts";

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
  test("fixes a `:=` misuse (compile error) on the first attempt with before/after", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "( $items := $scope.fetch.data.items; $items )",
      reasoning: "JSONata variables must be $-prefixed",
    });
    const bad = "items := $scope.fetch.data.items";
    const outcome = await repairTransformExpression({
      expression: bad,
      finding: { kind: "compile_error", message: "The left side of := must be a variable name" },
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(1);
    expect(outcome.before).toBe(bad);
    expect(outcome.after).toBe("( $items := $scope.fetch.data.items; $items )");
    expect(outcome.expression).toBe(outcome.after);
  });

  test("empty-result repair: a still-empty candidate is rejected mechanically, the second verified attempt wins", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.repair = () => {
      calls += 1;
      return calls === 1
        ? { expression: "$scope.fetch.data.nope" } // compiles, still empty
        : { expression: "$scope.fetch.data.items" }; // non-empty against recorded scope
    };
    const outcome = await repairTransformExpression({
      expression: "$scope.fetch.data.wrong_field",
      finding: { kind: "empty_result", message: "expression evaluated to an empty result" },
      scopeSample: RECORDED_SCOPE,
      pathCandidates: ["$scope.fetch.data.items"],
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(2);
    expect(outcome.after).toBe("$scope.fetch.data.items");
    expect(calls).toBe(2);
  });

  test("gives up cleanly after the attempt bound with repaired:false + last_error", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "$scope.fetch.data.still_wrong",
    });
    const outcome = await repairTransformExpression({
      expression: "$scope.fetch.data.wrong_field",
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

describe("build_workflow — repair proposals are PROPOSE-only", () => {
  function makeCtx(initial: DraftDocument | null): ToolContext & {
    current: () => DraftDocument | null;
  } {
    let draft: DraftDocument | null = initial;
    return {
      db: ctx.db,
      tenant_id,
      conversation_id: nextUuid(),
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
      getDraft: () => draft ?? createEmptyDraftDocument(),
      setDraft: async (d) => {
        draft = d;
      },
      current: () => draft,
    };
  }

  test("recorded-eval repair lands in the envelope; the accepted draft keeps the broken expression verbatim", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "$scope.fetch.data.items",
    });
    const fetch = {
      id: "fetch",
      kind: "request",
      method: "GET",
      url: "https://example.com/items",
    };
    const badExpression = "$scope.fetch.data.wrong_field";
    // Seed the conversation draft with fingerprint-valid recorded
    // evidence for `fetch`, so the rebuilt draft retains it (Fix 5)
    // and the recorded-eval pass can actually evaluate the transform.
    const seeded = {
      workflow: { name: "Seed", slug: "repair-propose", steps: [fetch] },
      latest_preview: {
        ok: true,
        step_id: "fetch",
        summary: "ok",
        step_traces: [
          {
            step_id: "fetch",
            kind: "request",
            status: "succeeded",
            fingerprint: stepFingerprint(fetch),
            output_preview: { items: [{ name: "Ada" }] },
            scope_at_step: {
              available_paths: ["items"],
              shape_summary: "object{items}",
              primary_data_path: "items",
            },
          },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    } as any as DraftDocument;
    const toolCtx = makeCtx(seeded);
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "Repair propose",
      slug: "repair-propose",
      steps: [
        fetch,
        { id: "shape", kind: "transform", language: "jsonata", expression: badExpression },
      ],
      environment: "dev",
    });

    expect(result.ok).toBe(true);
    const data = result.data as { recorded_eval: RecordedEvalReport };
    const finding = data.recorded_eval.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("empty_result");
    expect(finding?.repair?.repaired).toBe(true);
    if (!finding?.repair?.repaired) throw new Error("unreachable");
    expect(finding.repair.before).toBe(badExpression);
    expect(finding.repair.after).toBe("$scope.fetch.data.items");
    expect(data.recorded_eval.next_actions).toContain("update_param");
    expect(data.recorded_eval.summary).toContain("repair proposal");

    // ZERO draft mutation by the repair: the accepted draft carries the
    // model's expression verbatim — applying the repair is the model's
    // explicit next edit, never a side effect.
    const draftSteps = toolCtx.current()?.workflow.steps as Array<Record<string, unknown>>;
    const shape = draftSteps.find((s) => s.id === "shape");
    expect(shape?.expression).toBe(badExpression);
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
