import { describe, expect, test } from "bun:test";
import type { WorkflowSection } from "@/app/links";
import { triggerLabelKey, withSection } from "@/pages/workflows-model";

describe("workflow trigger words", () => {
  test("a request trigger reads as on request", () => {
    expect(triggerLabelKey({ kind: "request", source: "default", state: "active" })).toBe(
      "workflows.trigger.request",
    );
  });

  test("a bound schedule reads as a schedule, whatever the definition said", () => {
    expect(triggerLabelKey({ kind: "schedule", source: "binding", state: "active" })).toBe(
      "workflows.trigger.schedule",
    );
    expect(triggerLabelKey({ kind: "webhook", source: "binding", state: "active" })).toBe(
      "workflows.trigger.webhook",
    );
  });

  test("paused and held schedules have their own words", () => {
    expect(triggerLabelKey({ kind: "schedule", source: "binding", state: "paused" })).toBe(
      "workflows.trigger.schedulePaused",
    );
    expect(triggerLabelKey({ kind: "schedule", source: "binding", state: "held" })).toBe(
      "workflows.trigger.scheduleHeld",
    );
    expect(
      triggerLabelKey({ kind: "schedule", source: "binding", state: "activation_required" }),
    ).toBe("workflows.trigger.scheduleInactive");
  });

  test("a declared but unbound trigger does not read as one that fires", () => {
    const schedule = triggerLabelKey({
      kind: "schedule",
      source: "definition",
      state: "declared_unbound",
    });
    const webhook = triggerLabelKey({
      kind: "webhook",
      source: "definition",
      state: "declared_unbound",
    });
    expect(schedule).toBe("workflows.trigger.scheduleUnbound");
    expect(webhook).toBe("workflows.trigger.webhookUnbound");
    expect(schedule).not.toBe("workflows.trigger.schedule");
  });
});

describe("workflow sections", () => {
  test("opening and closing a section keeps the others as they are", () => {
    const none: ReadonlySet<WorkflowSection> = new Set();
    const build = withSection(none, "build", true);
    expect([...build]).toEqual(["build"]);
    expect([...withSection(build, "history", true)]).toEqual(["build", "history"]);
    expect([...withSection(build, "build", false)]).toEqual([]);
    expect(withSection(build, "build", true)).toBe(build);
  });
});
