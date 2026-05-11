// Authoring-critic — schema + gating unit tests.
//
// Pure: no DB, no LLM. Schema round-trips and the gating truth table.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { shouldRunCritic } from "../critic/gating.ts";
import { AuthoringCriticVerdictSchema } from "../critic/types.ts";

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

  test("rejects more than 5 repairs", () => {
    const result = AuthoringCriticVerdictSchema.safeParse({
      passed: false,
      repairs: ["a", "b", "c", "d", "e", "f"],
      rationale: "too many",
    });
    expect(result.success).toBe(false);
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

describe("shouldRunCritic — gating truth table", () => {
  beforeEach(() => {
    delete process.env.CRITIC_ENABLED;
    delete process.env.CRITIC_MIN_STEPS;
  });

  afterEach(() => {
    delete process.env.CRITIC_ENABLED;
    delete process.env.CRITIC_MIN_STEPS;
  });

  test("disabled by default (CRITIC_ENABLED unset)", () => {
    const d = shouldRunCritic({ stepCount: 10, recentDriftCount: 5 });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("disabled");
  });

  test("enabled + ≥ min_steps → run (reason: step_count)", () => {
    process.env.CRITIC_ENABLED = "true";
    const d = shouldRunCritic({ stepCount: 3, recentDriftCount: 0 });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("step_count");
  });

  test("enabled + step_count below threshold + recent drift → run (reason: recent_drift)", () => {
    process.env.CRITIC_ENABLED = "true";
    const d = shouldRunCritic({ stepCount: 1, recentDriftCount: 2 });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("recent_drift");
  });

  test("enabled + below threshold + no drift → no run (reason: below_threshold)", () => {
    process.env.CRITIC_ENABLED = "true";
    const d = shouldRunCritic({ stepCount: 1, recentDriftCount: 0 });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("below_threshold");
  });

  test("CRITIC_MIN_STEPS overrides the default threshold", () => {
    process.env.CRITIC_ENABLED = "true";
    process.env.CRITIC_MIN_STEPS = "5";
    // 3 steps now NOT enough; default would have triggered.
    const below = shouldRunCritic({ stepCount: 3, recentDriftCount: 0 });
    expect(below.run).toBe(false);
    expect(below.reason).toBe("below_threshold");
    const above = shouldRunCritic({ stepCount: 5, recentDriftCount: 0 });
    expect(above.run).toBe(true);
    expect(above.reason).toBe("step_count");
  });

  test("invalid CRITIC_MIN_STEPS falls back to default", () => {
    process.env.CRITIC_ENABLED = "true";
    process.env.CRITIC_MIN_STEPS = "not-a-number";
    const d = shouldRunCritic({ stepCount: 3, recentDriftCount: 0 });
    expect(d.run).toBe(true); // default 3, so 3 passes
    expect(d.reason).toBe("step_count");
  });

  test("CRITIC_ENABLED=1 is truthy", () => {
    process.env.CRITIC_ENABLED = "1";
    const d = shouldRunCritic({ stepCount: 3, recentDriftCount: 0 });
    expect(d.run).toBe(true);
  });

  test("CRITIC_ENABLED=false is explicitly off", () => {
    process.env.CRITIC_ENABLED = "false";
    const d = shouldRunCritic({ stepCount: 10, recentDriftCount: 0 });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("disabled");
  });
});
