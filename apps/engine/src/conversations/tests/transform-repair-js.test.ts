// Bounded auto-repair of `language: "javascript"` transform bodies
// (Fix F). Same discipline as the JSONata repair:
//
//   - fixes a broken function body (syntax / throw / empty result)
//     within ≤2 attempts, mechanically verified in the QuickJS sandbox
//     against the RECORDED scope (production context shape
//     `{ scope, input }` — data at `input.scope.<step_id>.data…`),
//   - a candidate that runs but still returns an empty result is
//     rejected mechanically,
//   - gives up cleanly after the attempt bound,
//   - rides the recorded-eval pass with the site's language attached.
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
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { runRecordedEval } from "../recorded-eval.ts";
import { stepFingerprint } from "../step-fingerprint.ts";
import { MAX_REPAIR_ATTEMPTS, repairTransformExpression } from "../transform-repair.ts";

let ctx: TestDb;
let tenant_id: string;

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    /* fall through */
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-transform-repair-js-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/transform-repair-js",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  await ensureConfigLoaded();
  ctx = await createTestDb("transform_repair_js");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-repair-js", display_name: "T" })
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

describe("repairTransformExpression — javascript function bodies", () => {
  test("fixes a syntax-broken body on the first attempt with before/after", async () => {
    const fixed = "const names = input.scope.fetch.data.items.map((i) => i.name);\nreturn names;";
    getMockProvider().generateOverrides.repair = () => ({
      expression: fixed,
      reasoning: "missing closing parenthesis",
    });
    const bad = "const names = input.scope.fetch.data.items.map((i) => i.name;\nreturn names;";
    const outcome = await repairTransformExpression({
      expression: bad,
      language: "javascript",
      finding: { kind: "compile_error", message: "SyntaxError: unexpected token" },
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(1);
    expect(outcome.before).toBe(bad);
    expect(outcome.after).toBe(fixed);
  });

  test("a syntax-broken candidate is rejected mechanically (sandbox parse check)", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.repair = () => {
      calls += 1;
      return calls === 1
        ? { expression: "const x = ;\nreturn x;" } // still broken
        : { expression: "return input.scope.fetch.data.items;" };
    };
    const outcome = await repairTransformExpression({
      expression: "const y = )\nreturn y;",
      language: "javascript",
      finding: { kind: "compile_error", message: "SyntaxError: unexpected token" },
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  test("empty-result repair: a still-empty candidate is rejected against the recorded scope, the verified attempt wins", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.repair = () => {
      calls += 1;
      return calls === 1
        ? { expression: "return input.scope.fetch.data.nope;" } // runs, still empty
        : { expression: "return input.scope.fetch.data.items;" }; // non-empty
    };
    const outcome = await repairTransformExpression({
      expression: "return input.scope.fetch.data.wrong_field;",
      language: "javascript",
      finding: { kind: "empty_result", message: "function body returned an empty result" },
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

  test("eval_error repair: the candidate must run without throwing against the recorded scope", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "return (input.scope.fetch.data.items ?? []).map((i) => i.name);",
    });
    const outcome = await repairTransformExpression({
      expression: "return input.scope.fetch.data.missing.map((i) => i.name);",
      language: "javascript",
      finding: { kind: "eval_error", message: "TypeError: cannot read property 'map'" },
      scopeSample: RECORDED_SCOPE,
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(1);
  });

  test("gives up cleanly after the attempt bound with repaired:false + last_error", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.repair = () => {
      calls += 1;
      return calls === 1
        ? { expression: "return input.scope.fetch.data.nope;" }
        : { expression: "return input.scope.fetch.data.also_nope;" };
    };
    const outcome = await repairTransformExpression({
      expression: "return input.scope.fetch.data.wrong_field;",
      language: "javascript",
      finding: { kind: "empty_result", message: "function body returned an empty result" },
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

describe("runRecordedEval — JS findings ride the repair stage with their language", () => {
  test("a JS empty_result finding gets a verified JS repair proposal", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "return input.scope.fetch.data.items;",
    });
    const fetch = {
      id: "fetch",
      kind: "request",
      method: "GET",
      url: "https://example.com/items",
    };
    const report = await runRecordedEval(
      {
        steps: [
          fetch,
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return input.scope.fetch.data.wrong_field;",
          },
        ],
      },
      {
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
      },
      { repair: { tenant_id, db: ctx.db } },
    );
    const finding = report.expressions.find((f) => f.site === "steps.shape.expression");
    expect(finding?.status).toBe("empty_result");
    expect(finding?.repair?.repaired).toBe(true);
    if (!finding?.repair?.repaired) throw new Error("unreachable");
    expect(finding.repair.after).toBe("return input.scope.fetch.data.items;");
    expect(report.next_actions).toContain("edit_workflow_patch");
  });
});
