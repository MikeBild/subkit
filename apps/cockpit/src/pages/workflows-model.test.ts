import { describe, expect, test } from "bun:test";
import { connectorSlugHref, triggerLabelKey } from "@/pages/workflows-model";

describe("workflow connector relations", () => {
  const slugToId = new Map([["reporting-api", "018f4b4a-6d33-7b3a-9c2d-123456789abc"]]);

  test("links a known slug to the connector it names", () => {
    expect(connectorSlugHref("reporting-api", slugToId)).toBe(
      "/cockpit/connectors/018f4b4a-6d33-7b3a-9c2d-123456789abc",
    );
  });

  test("gives an unmapped slug no link at all", () => {
    expect(connectorSlugHref("retired-service", slugToId)).toBeNull();
  });
});

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
