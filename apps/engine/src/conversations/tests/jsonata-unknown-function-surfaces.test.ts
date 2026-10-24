import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig } from "../../config/loader.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  describeUnknownFunction,
  evaluate,
  findUnknownFunctionCalls,
} from "../../execution/jsonata-engine.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { buildGenerationPrompt, JSONATA_ARGMAX_IDIOM } from "../authoring-pipeline.ts";
import { evaluateJsonataSite } from "../recorded-eval.ts";
import { repairTransformExpression } from "../transform-repair.ts";

let ctx: TestDb;
let tenant_id: string;

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-jsonata-unknown-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/jsonata-unknown",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  await ensureConfigLoaded();
  ctx = await createTestDb("jsonata_unknown_surfaces");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-jsonata-unknown", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
});

const INDEX_OF = "$indexOf($scope.fetch.data, 1)";
const MESSAGE = describeUnknownFunction(findUnknownFunctionCalls(INDEX_OF)[0]!);
const STEPS = [
  {
    id: "fetch",
    kind: "request",
    method: "GET",
    url: "https://jsonplaceholder.typicode.com/users",
  },
];

function repairPrompts(): string[] {
  return getMockProvider()
    .calls.filter((c) => c.flow === "repair")
    .map((c) => c.last_user);
}

describe("unknown JSONata function · one message on every surface", () => {
  test("validator and recorded-eval agree on the message and the site", async () => {
    const validator = validateWorkflowDef({
      name: "surfaces",
      steps: STEPS,
      output_transform: INDEX_OF,
    });
    expect(validator.ok).toBe(false);
    expect(validator.errors).toContainEqual({ path: "output_transform", message: MESSAGE });

    const recorded = await evaluateJsonataSite(
      {
        site: "output_transform",
        step_id: null,
        language: "jsonata",
        expression: INDEX_OF,
        evaluable: true,
      },
      ["fetch"],
      true,
      { fetch: { data: [1, 2], duration_ms: 1, error: null } },
      null,
    );
    expect(recorded.status).toBe("compile_error");
    expect(recorded.message).toBe(MESSAGE);
    expect(typeof recorded.position).toBe("number");
  });

  test("built-ins and := bound functions raise no unknown-function finding", () => {
    const validator = validateWorkflowDef({
      name: "bound-functions",
      steps: STEPS,
      output_transform: "($f := function($x) { $x }; $map($scope.fetch.data, $f))",
    });
    expect(validator.errors.filter((e) => e.path === "output_transform")).toEqual([]);
  });
});

describe("repairTransformExpression · unknown functions never pass verification", () => {
  test("a candidate that swaps $indexOf for $find is rejected and the next prompt names it", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.repair = () => {
      calls += 1;
      return calls === 1
        ? { expression: "$find($scope.fetch.data, 1)" }
        : { expression: "$scope.fetch.data[0]" };
    };
    const outcome = await repairTransformExpression({
      expression: INDEX_OF,
      language: "jsonata",
      finding: { kind: "compile_error", message: MESSAGE },
      site: "output_transform",
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(2);
    expect(outcome.after).toBe("$scope.fetch.data[0]");
    const prompts = repairPrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("JSONata has no function `$find`");
    expect(prompts[0]).toContain("JSONata has NO JavaScript array/string methods");
  });
});

describe("repair prompt · workflow output sites carry the engine contract", () => {
  test("output_transform_function: `input` is the final value, no input.scope", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: "return { rows: input };" });
    await repairTransformExpression({
      expression: "return { rows: input.scope.fetch.data };",
      language: "javascript",
      finding: { kind: "eval_error", message: "output_transform_function threw: TypeError" },
      site: "output_transform_function",
      tenant_id,
      db: ctx.db,
    });
    const prompts = repairPrompts();
    expect(prompts.length).toBeGreaterThan(0);
    const prompt = prompts[0]!;
    expect(prompt).toContain(
      "A JavaScript `output_transform_function` in a workflow draft failed.",
    );
    expect(prompt).toContain("FUNCTION BODY");
    expect(prompt).toContain("the workflow's final output — the last step's `.data`");
    expect(prompt).toContain("There is NO `input.scope` and NO `input.input` here");
    expect(prompt).not.toContain("input.scope.<step_id>.data` — recorded output");
  });

  test("output_transform: the root is the final value, $scope and $input are bound", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: "$scope.fetch.data[0]" });
    const outcome = await repairTransformExpression({
      expression: INDEX_OF,
      language: "jsonata",
      finding: { kind: "eval_error", message: "output_transform threw" },
      site: "output_transform",
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    const [prompt] = repairPrompts();
    expect(prompt).toContain("A JSONata `output_transform` in a workflow draft failed.");
    expect(prompt).toContain("The root value (`$`, bare paths) is the workflow's final output");
    expect(prompt).toContain("`$scope.<step_id>.data`, the workflow input as `$input`");
  });

  test("a step transform keeps the step-scope contract", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "return input.scope.fetch.data;",
    });
    await repairTransformExpression({
      expression: "return input.scope.fetch.nope;",
      language: "javascript",
      finding: { kind: "eval_error", message: "TypeError" },
      site: "steps.shape.expression",
      tenant_id,
      db: ctx.db,
    });
    const [prompt] = repairPrompts();
    expect(prompt).toContain("A JavaScript transform in a workflow draft failed.");
    expect(prompt).toContain(
      "`input.scope.<step_id>.data` — recorded output of each upstream step",
    );
    expect(prompt).not.toContain("output_transform_function");
  });
});

describe("generation prompt · JSONata contract", () => {
  const prompt = buildGenerationPrompt({
    goal: "Return the hottest day from the forecast",
    connectors: [],
    docsByConnector: new Map(),
    samplesSection: null,
  });

  test("names the missing JavaScript methods, the built-ins, the idioms and the output contract", () => {
    expect(prompt).toContain("## JSONata contract");
    expect(prompt).toContain(
      "JSONata has NO JavaScript array/string methods — `$indexOf`, `$find`, `$includes`, `$slice`, `$toFixed` do not exist and throw at runtime",
    );
    expect(prompt).toContain("- Built-ins: $sum $count $max");
    expect(prompt).toContain(
      "$base64encode $base64decode $toMillis $fromMillis $clone $now $millis.",
    );
    expect(prompt).not.toContain("$eval");
    expect(prompt).toContain("indexOf → `($arr#$i[$ = value].$i)[0]`");
    expect(prompt).toContain(`verified idiom: \`${JSONATA_ARGMAX_IDIOM}\``);
    expect(prompt).toContain(
      "`output_transform_function` is the JavaScript alternative — a FUNCTION BODY whose single `input` IS that final value (there is NO `input.scope` and NO `input.input` there)",
    );
  });

  test("the Argmax idiom evaluates to the hottest day against a forecast-shaped scope", async () => {
    expect(findUnknownFunctionCalls(JSONATA_ARGMAX_IDIOM)).toEqual([]);
    const daily = { time: ["mon", "tue", "wed"], temperature_2m_max: [18.2, 23.9, 21.4] };
    const result = await evaluate(JSONATA_ARGMAX_IDIOM, daily, {
      scope: { forecast: { data: { daily }, duration_ms: 1, error: null } },
    });
    expect(result).toEqual({ hottest_day: "tue", max_temp: 23.9 });
  });

  test("the prompt is static across calls", () => {
    const again = buildGenerationPrompt({
      goal: "Return the hottest day from the forecast",
      connectors: [],
      docsByConnector: new Map(),
      samplesSection: null,
    });
    expect(again).toBe(prompt);
  });
});
