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
  test("a workflow without a trigger runs on request, it is not unknown", () => {
    expect(triggerLabelKey(null)).toBe("workflows.trigger.request");
    expect(triggerLabelKey(undefined)).toBe("workflows.trigger.request");
  });

  test("names the declared trigger kinds", () => {
    expect(triggerLabelKey({ kind: "schedule", cron: "0 6 * * *", tz: "UTC" })).toBe(
      "workflows.trigger.schedule",
    );
    expect(triggerLabelKey({ kind: "webhook", source: "stripe", events: [], verify: "none" })).toBe(
      "workflows.trigger.webhook",
    );
  });
});
