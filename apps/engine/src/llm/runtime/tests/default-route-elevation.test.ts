import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import type { ModelRoute } from "../../types.ts";
import { applyFlowModelElevation, globalLlmStatus } from "../invoke.ts";
import { routeUp } from "../step-router.ts";

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sk-default-route-"));
  const cfgPath = join(dir, "subkit.config.json");
  writeFileSync(cfgPath, JSON.stringify({ database: { url: "postgres://x:y@127.0.0.1:5432/z" } }));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://x:y@127.0.0.1:5432/z", NODE_ENV: "test" },
    configPathOverride: cfgPath,
  });
});

afterAll(() => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

function defaultRoute(): ModelRoute {
  const status = globalLlmStatus();
  return {
    primary: status.default_primary,
    fallback: status.default_fallback,
    provider: "anthropic",
    fallback_provider: "anthropic",
    context_cap: 200_000,
  } as ModelRoute;
}

describe("the shipped default route", () => {
  test("elevating judge raises the tier instead of lowering it", () => {
    const route = defaultRoute();
    const elevated = applyFlowModelElevation(route, "judge");

    expect(elevated.primary).not.toBe(route.primary);
    const oneUp = routeUp("anthropic", route.primary);
    expect(oneUp).not.toBe(route.primary);
    expect(elevated.primary).toBe(oneUp);
  });

  test("the demoted primary stays reachable as the fallback", () => {
    const route = defaultRoute();
    const elevated = applyFlowModelElevation(route, "judge");
    expect(elevated.fallback).toBe(route.primary);
  });

  test("generate is elevated the same way, converse is left alone", () => {
    const route = defaultRoute();
    expect(applyFlowModelElevation(route, "generate").primary).not.toBe(route.primary);
    expect(applyFlowModelElevation(route, "converse").primary).toBe(route.primary);
  });
});

describe("the Anthropic escalation ladder", () => {
  test("no rung lands on a model an earlier rung already superseded", () => {
    expect(routeUp("anthropic", "claude-haiku-4-5")).toBe("claude-sonnet-4-6");
  });

  test("every rung actually moves", () => {
    for (const model of [
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
    ]) {
      expect(routeUp("anthropic", model)).not.toBe(model);
    }
  });
});
