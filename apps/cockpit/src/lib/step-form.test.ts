import { describe, expect, test } from "bun:test";
import { formatDuration, formFromStep, parseDuration, stepFromForm } from "./step-form";

const CONNECTOR = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

describe("step form", () => {
  test("durations read as the dialog writes them", () => {
    expect(parseDuration("5 min")).toBe(300_000);
    expect(parseDuration("30 s")).toBe(30_000);
    expect(parseDuration("2 h")).toBe(7_200_000);
    expect(parseDuration("10")).toBe(600_000);
    expect(parseDuration("25 h")).toBeNull();
    expect(parseDuration("bald")).toBeNull();
    expect(formatDuration(300_000)).toBe("5 min");
    expect(formatDuration(7_200_000)).toBe("2 h");
    expect(formatDuration(45_000)).toBe("45 s");
  });

  test("a stored call opens with its values and keeps what the form does not show", () => {
    const stored = {
      id: "send-mail",
      kind: "request",
      connector_id: CONNECTOR,
      method: "POST",
      path: "/messages/send",
      body: { to: "input.to" },
    };
    const form = formFromStep(stored, "");
    expect(form).toMatchObject({ name: "send-mail", kind: "request", method: "POST" });
    const result = stepFromForm({ ...form, path: "/messages/draft" }, stored, []);
    expect(result).toEqual({
      step: { ...stored, path: "/messages/draft" },
    });
  });

  test("changing the kind starts the step afresh", () => {
    const stored = { id: "pause", kind: "request", connector_id: CONNECTOR, path: "/x", body: {} };
    const result = stepFromForm(
      { ...formFromStep(stored, ""), kind: "wait", wait: "5 min" },
      stored,
      [],
    );
    expect(result).toEqual({ step: { id: "pause", kind: "wait", duration_ms: 300_000 } });
  });

  test("what is wrong is named", () => {
    const form = formFromStep(null, CONNECTOR);
    expect(stepFromForm({ ...form, name: "" }, null, [])).toEqual({ error: "nameMissing" });
    expect(stepFromForm({ ...form, name: "Send!" }, null, [])).toEqual({ error: "nameInvalid" });
    expect(stepFromForm({ ...form, name: "a" }, null, ["a"])).toEqual({ error: "nameTaken" });
    expect(stepFromForm({ ...form, name: "a", path: "messages" }, null, [])).toEqual({
      error: "pathInvalid",
    });
    expect(stepFromForm({ ...form, name: "a", connectorId: "" }, null, [])).toEqual({
      error: "connectorMissing",
    });
    expect(stepFromForm({ ...form, name: "a", kind: "wait", wait: "x" }, null, [])).toEqual({
      error: "waitInvalid",
    });
  });

  test("a name with spaces becomes one with dashes", () => {
    const form = { ...formFromStep(null, CONNECTOR), kind: "transform" as const, name: "Clean up" };
    expect(stepFromForm(form, null, [])).toMatchObject({ step: { id: "clean-up" } });
  });
});
