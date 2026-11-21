import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../..");
const DIRECT_MODEL_CALL = /\b(?:streamText|generateText|generateObject|streamObject)\(/;

const GATED: Readonly<Record<string, string>> = {
  "conversations/loop/attempt.ts": "chat and task turns pass preflightTurn → turnBudgetVerdict",
  "conversations/loop/suggest-next-emitter.ts": "finalizeTurn suppresses it through budget_guard",
  "llm/runtime/ai-sdk-model.ts": "the model wrapper; its callers are gated",
  "llm/runtime/base-types.ts": "type declarations only",
  "llm/runtime/invoke.ts": "every flow passes checkAndDecrement",
  "llm/runtime/repair-tool-call.ts": "repairs a tool call inside an admitted turn",
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return ["tests", "test-helpers", "__tests__", "node_modules"].includes(name)
        ? []
        : sources(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the spending limit boundary", () => {
  test("every direct model call site is a gated boundary", () => {
    const sites = sources(SRC)
      .filter((path) => DIRECT_MODEL_CALL.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path))
      .sort();
    expect(sites).toEqual(Object.keys(GATED).sort());
  });

  test("the shared budget check carries the dollar limit", () => {
    const budget = readFileSync(join(SRC, "llm/accounting/budget.ts"), "utf8");
    expect(budget).toContain("spendVerdict(");
    const step = readFileSync(join(SRC, "execution/steps/request/drivers/http-single.ts"), "utf8");
    expect(step).toContain("spendVerdict(");
  });
});
