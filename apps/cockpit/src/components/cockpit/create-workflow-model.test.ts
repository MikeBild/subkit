import { describe, expect, test } from "bun:test";
import { manualWorkflowDefinition } from "./create-workflow-model";

const base = {
  name: " Daily report ",
  slug: "daily-report",
  purpose: "",
  schedule: () => ({ cron: "0 8 * * *", timezone: "Europe/Berlin" }),
};

describe("manualWorkflowDefinition", () => {
  test("starts with one transform step and leaves the error policy to the engine default", () => {
    expect(manualWorkflowDefinition({ ...base, trigger: "request" })).toEqual({
      name: "Daily report",
      slug: "daily-report",
      steps: [{ id: "start", kind: "transform", expression: "return input;" }],
      trigger: { kind: "request" },
    });
  });

  test("keeps a trimmed purpose as description", () => {
    expect(
      manualWorkflowDefinition({ ...base, purpose: "  Sends the report. ", trigger: "request" })
        .description,
    ).toBe("Sends the report.");
  });

  test("a schedule trigger carries cron and timezone", () => {
    expect(manualWorkflowDefinition({ ...base, trigger: "schedule" }).trigger).toEqual({
      kind: "schedule",
      cron: "0 8 * * *",
      tz: "Europe/Berlin",
    });
  });

  test("only a schedule trigger reads the rhythm", () => {
    const schedule = () => {
      throw new Error("invalid time");
    };
    expect(manualWorkflowDefinition({ ...base, schedule, trigger: "request" }).trigger).toEqual({
      kind: "request",
    });
  });

  test("a webhook trigger listens on the workflow slug", () => {
    expect(manualWorkflowDefinition({ ...base, trigger: "webhook" }).trigger).toEqual({
      kind: "webhook",
      source: "daily-report",
      events: [],
      verify: "none",
    });
  });
});
