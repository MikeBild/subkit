// Authoring-critic — schema + gating unit tests.
//
// Pure: no DB, no LLM. Schema round-trips and the gating truth table.
// Gating reads from the runtime config loader; tests bootstrap a fresh
// disposable config file per suite and use `setConfigKey` to flip the
// per-tenant-shaped leaves at runtime (matching the
// `sk settings configure` operator path). NO env-var feature flags.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import { shouldRunCritic } from "../authoring-critic/gating.ts";
import {
  AuthoringCriticVerdictSchema,
  CriticRejectedDetailsSchema,
  REPAIRS_CAP,
} from "../authoring-critic/types.ts";

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    /* fall through */
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-critic-unit-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/critic-unit", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

describe("AuthoringCriticVerdictSchema", () => {
  test("accepts a passed verdict with empty repairs", () => {
    const parsed = AuthoringCriticVerdictSchema.parse({
      passed: true,
      repairs: [],
      rationale: "no semantic drift",
    });
    expect(parsed.passed).toBe(true);
    expect(parsed.repairs).toEqual([]);
  });

  test("accepts a failed verdict with up to 5 repairs", () => {
    const parsed = AuthoringCriticVerdictSchema.parse({
      passed: false,
      repairs: ["fix step order", "rewrite output_transform", "add idempotency_key"],
      rationale: "three issues",
    });
    expect(parsed.passed).toBe(false);
    expect(parsed.repairs).toHaveLength(3);
  });

  test("clamps repairs > 5 to the first 5 instead of failing", () => {
    const parsed = AuthoringCriticVerdictSchema.parse({
      passed: false,
      repairs: ["a", "b", "c", "d", "e", "f", "g"],
      rationale: "too many",
    });
    expect(parsed.repairs).toHaveLength(REPAIRS_CAP);
    expect(parsed.repairs[0]).toBe("a");
    expect(parsed.repairs[4]).toBe("e");
  });

  test("truncates rationale > 800 chars instead of failing", () => {
    const longRationale = "x".repeat(2000);
    const parsed = AuthoringCriticVerdictSchema.parse({
      passed: false,
      repairs: ["fix"],
      rationale: longRationale,
    });
    expect(parsed.rationale.length).toBe(800);
  });

  test("rejects empty rationale", () => {
    const result = AuthoringCriticVerdictSchema.safeParse({
      passed: false,
      repairs: ["fix it"],
      rationale: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing fields", () => {
    expect(AuthoringCriticVerdictSchema.safeParse({}).success).toBe(false);
    expect(AuthoringCriticVerdictSchema.safeParse({ passed: true, repairs: [] }).success).toBe(
      false,
    );
  });
});

describe("CriticRejectedDetailsSchema", () => {
  test("parses the contract producer/consumer share", () => {
    const parsed = CriticRejectedDetailsSchema.parse({
      repairs: ["fix this"],
      rationale: "because",
      gating_reason: "step_count",
    });
    expect(parsed.repairs).toEqual(["fix this"]);
  });

  test("gating_reason is optional", () => {
    const parsed = CriticRejectedDetailsSchema.parse({
      repairs: [],
      rationale: "no problems",
    });
    expect(parsed.gating_reason).toBeUndefined();
  });
});

describe("shouldRunCritic — gating truth table (runtime config)", () => {
  beforeAll(async () => {
    await ensureConfigLoaded();
  });

  afterAll(async () => {
    // Restore disabled default so neighbouring suites in the same Bun
    // process don't inherit a hot critic.
    await setConfigKey(["llm", "critic", "enabled"], false);
    await setConfigKey(["llm", "critic", "min_steps"], 3);
    await setConfigKey(["llm", "critic", "max_consecutive_rejections"], 3);
  });

  test("disabled by default (config llm.critic.enabled=false)", async () => {
    await setConfigKey(["llm", "critic", "enabled"], false);
    const d = shouldRunCritic({ stepCount: 10, recentDriftCount: 5, consecutiveRejections: 0 });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("disabled");
  });

  test("enabled + ≥ min_steps → run (reason: step_count)", async () => {
    await setConfigKey(["llm", "critic", "enabled"], true);
    await setConfigKey(["llm", "critic", "min_steps"], 3);
    const d = shouldRunCritic({ stepCount: 3, recentDriftCount: 0, consecutiveRejections: 0 });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("step_count");
  });

  test("enabled + below threshold + recent drift → run (reason: recent_drift)", async () => {
    await setConfigKey(["llm", "critic", "enabled"], true);
    await setConfigKey(["llm", "critic", "min_steps"], 3);
    const d = shouldRunCritic({ stepCount: 1, recentDriftCount: 2, consecutiveRejections: 0 });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("recent_drift");
  });

  test("enabled + below threshold + no drift → no run (reason: below_threshold)", async () => {
    await setConfigKey(["llm", "critic", "enabled"], true);
    await setConfigKey(["llm", "critic", "min_steps"], 3);
    const d = shouldRunCritic({ stepCount: 1, recentDriftCount: 0, consecutiveRejections: 0 });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("below_threshold");
  });

  test("min_steps config override changes the threshold", async () => {
    await setConfigKey(["llm", "critic", "enabled"], true);
    await setConfigKey(["llm", "critic", "min_steps"], 5);
    const below = shouldRunCritic({ stepCount: 3, recentDriftCount: 0, consecutiveRejections: 0 });
    expect(below.run).toBe(false);
    expect(below.reason).toBe("below_threshold");
    const above = shouldRunCritic({ stepCount: 5, recentDriftCount: 0, consecutiveRejections: 0 });
    expect(above.run).toBe(true);
    expect(above.reason).toBe("step_count");
  });

  test("anti-loop: ≥ max_consecutive_rejections short-circuits with reason:anti_loop", async () => {
    await setConfigKey(["llm", "critic", "enabled"], true);
    await setConfigKey(["llm", "critic", "min_steps"], 3);
    await setConfigKey(["llm", "critic", "max_consecutive_rejections"], 3);
    const stuck = shouldRunCritic({ stepCount: 10, recentDriftCount: 5, consecutiveRejections: 3 });
    expect(stuck.run).toBe(false);
    expect(stuck.reason).toBe("anti_loop");
  });

  test("per-tenant overlay flips the gate for one tenant only", async () => {
    // Global stays disabled; tenant A gets an explicit overlay = true.
    await setConfigKey(["llm", "critic", "enabled"], false);
    const tenantA = "11111111-1111-4111-8111-111111111111";
    const tenantB = "22222222-2222-4222-8222-222222222222";
    await setConfigKey(["llm", "critic", "enabled"], true, { tenantId: tenantA });

    const inputs = { stepCount: 3, recentDriftCount: 0, consecutiveRejections: 0 };
    const decisionA = shouldRunCritic({ ...inputs, tenantId: tenantA });
    const decisionB = shouldRunCritic({ ...inputs, tenantId: tenantB });
    const decisionGlobal = shouldRunCritic(inputs);

    expect(decisionA.run).toBe(true);
    expect(decisionA.reason).toBe("step_count");
    expect(decisionB.run).toBe(false);
    expect(decisionB.reason).toBe("disabled");
    expect(decisionGlobal.run).toBe(false);
    expect(decisionGlobal.reason).toBe("disabled");

    // Reset the overlay so adjacent tests don't inherit it.
    await setConfigKey(["llm", "critic", "enabled"], false, { tenantId: tenantA });
  });
});

describe("Critic system prompt — invariant snapshot", () => {
  test("BASE_SYSTEM_PROMPTS.critic_authoring carries the no-patch / structured-verdict invariants", async () => {
    const mod = await import("../../llm/core/context-assembler.ts");
    const text = await mod.basePromptFor("critic_authoring");
    // Author intent must persist across edits — if these fail, the
    // prompt was changed without updating the invariants doc-tested
    // here. Discuss before relaxing.
    expect(text).toMatch(/SEMANTIC drift/i);
    expect(text).toMatch(/passed:true/i);
    expect(text).toMatch(/empty repairs array/i);
    expect(text).toMatch(/5/);
    expect(text).toMatch(/Do NOT propose code or patches/i);
  });
});
