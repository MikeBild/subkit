// The shipped default route has to satisfy the assumption its own elevation
// makes.
//
// `applyFlowModelElevation` swaps `judge` and `generate` onto the route's
// FALLBACK, on the stated convention that the fallback is the stronger model —
// cheap primary for volume, strong fallback for capability. That convention is
// load-bearing and was, in the shipped default, false: primary
// `claude-sonnet-4-6`, fallback `claude-sonnet-4-5`. The two flows that exist
// to be elevated were being demoted instead, on every default install.
//
// Nothing caught it because every real deployment overrides the models in
// config, so the default was exercised only by CI — where the nightly judge job
// pins nothing on purpose, precisely so it rides what ships. It failed for four
// nights while its sibling job, pinning `claude-sonnet-4-6` against the same
// key, passed.
//
// These tests pin the shape rather than the model names alone: an elevation
// that does not raise the tier is the defect, whatever the ids are.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import type { ModelRoute } from "../../types.ts";
import { applyFlowModelElevation, globalLlmStatus } from "../invoke.ts";
import { routeUp } from "../step-router.ts";

// A config with no `llm.model` / `llm.fallback_model` — which is the whole
// point: this suite is about what an operator gets when they set nothing.
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
    monthly_budget: null,
  } as ModelRoute;
}

describe("the shipped default route", () => {
  test("elevating judge raises the tier instead of lowering it", () => {
    const route = defaultRoute();
    const elevated = applyFlowModelElevation(route, "judge");

    // The elevation must actually move.
    expect(elevated.primary).not.toBe(route.primary);
    // And it must move UP: the default primary's one-up on the Anthropic ladder
    // is the weakest thing that counts as an elevation. Asserting via the
    // ladder rather than a literal keeps this true when the model ids roll.
    const oneUp = routeUp("anthropic", route.primary);
    expect(oneUp).not.toBe(route.primary);
    expect(elevated.primary).toBe(oneUp);
  });

  test("the demoted primary stays reachable as the fallback", () => {
    // An overloaded strong model has to degrade to the cheaper one rather than
    // retry itself — the swap is why elevation does not collapse
    // primary === fallback.
    const route = defaultRoute();
    const elevated = applyFlowModelElevation(route, "judge");
    expect(elevated.fallback).toBe(route.primary);
  });

  test("generate is elevated the same way, converse is left alone", () => {
    const route = defaultRoute();
    expect(applyFlowModelElevation(route, "generate").primary).not.toBe(route.primary);
    // The chat-frequency flows carry the token volume and must not be moved.
    expect(applyFlowModelElevation(route, "converse").primary).toBe(route.primary);
  });
});

describe("the Anthropic escalation ladder", () => {
  test("no rung lands on a model an earlier rung already superseded", () => {
    // `claude-sonnet-4-5` is behind `claude-sonnet-4-6`, and production runs
    // Haiku as its primary — so a Haiku one-up into 4-5 was the escalation most
    // likely to fire, landing a generation short every time.
    expect(routeUp("anthropic", "claude-haiku-4-5")).toBe("claude-sonnet-4-6");
  });

  test("every rung actually moves", () => {
    // A ladder entry mapping a model to itself reports success while changing
    // nothing — the `no_upgrade_available` class of dead edge.
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
