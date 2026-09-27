import { describe, expect, test } from "bun:test";
import { effectiveTriggerLabel } from "./effective-trigger.ts";

const schedule = {
  id: "s1",
  cron: "7 * * * *",
  timezone: "UTC",
  paused: false,
  execution_mode: "prod" as const,
  admission_hold: null,
  next_fire_at: null,
  last_enqueued_at: null,
};

describe("effectiveTriggerLabel", () => {
  test("a bound schedule names its cron even when the definition declares nothing", () => {
    expect(
      effectiveTriggerLabel({
        effective_trigger: { kind: "schedule", source: "binding", state: "active" },
        schedule,
        webhooks_active: 0,
      }),
    ).toBe("schedule 7 * * * * UTC");
  });

  test("paused and held schedules say so", () => {
    const paused = { kind: "schedule", source: "binding", state: "paused" } as const;
    const held = { kind: "schedule", source: "binding", state: "held" } as const;
    expect(effectiveTriggerLabel({ effective_trigger: paused, schedule })).toBe(
      "schedule 7 * * * * UTC (paused)",
    );
    expect(effectiveTriggerLabel({ effective_trigger: held, schedule })).toBe(
      "schedule 7 * * * * UTC (held)",
    );
  });

  test("a declared but unbound schedule is not reported as a schedule that fires", () => {
    expect(
      effectiveTriggerLabel({
        effective_trigger: { kind: "schedule", source: "definition", state: "declared_unbound" },
        schedule: null,
      }),
    ).toBe("schedule declared, not bound");
  });

  test("webhooks report their active count; nothing at all is request", () => {
    expect(
      effectiveTriggerLabel({
        effective_trigger: { kind: "webhook", source: "binding", state: "active" },
        webhooks_active: 2,
      }),
    ).toBe("webhook (2 active)");
    expect(effectiveTriggerLabel({})).toBe("request");
  });
});
