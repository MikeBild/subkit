import { expect, test } from "bun:test";
import { intentFromBody, workflowDefinition } from "./workflow-file-model.ts";

test("file definitions retain their data and reject missing structural fields", () => {
  const definition = { name: "Example", steps: [], input_schema: { type: "object" } };
  expect(workflowDefinition(definition)).toBe(definition);
  for (const invalid of [
    {},
    { name: 4, steps: [] },
    { name: "Example" },
    { name: "Example", steps: {} },
  ]) {
    expect(() => workflowDefinition(invalid)).toThrow(
      "the workflow definition needs a name and a steps array",
    );
  }
});

test("intent reads direct and nested definitions without changing them", () => {
  const nested = {
    name: "Example",
    slug: "example",
    definition: {
      steps: [{ key: "key", id: "ignored", kind: "transform" }, { id: "id" }, null, {}],
    },
  };
  expect(intentFromBody(nested)).toEqual({
    kind: "workflow",
    name: "Example",
    slug: "example",
    trigger: { kind: "request" },
    steps: [
      { key: "key", kind: "transform" },
      { key: "id", kind: "step" },
      { key: "(step)", kind: "step" },
      { key: "(step)", kind: "step" },
    ],
  });
  expect(intentFromBody({ steps: [], name: 42, slug: 42 })).toEqual({
    kind: "workflow",
    name: "(workflow)",
    trigger: { kind: "request" },
    steps: [],
  });
  expect(intentFromBody({})).toEqual({
    kind: "workflow",
    name: "(workflow)",
    trigger: { kind: "request" },
    steps: [],
  });
});

test("trigger previews keep schedule and webhook values and their fallbacks", () => {
  const trigger = (value: unknown) => intentFromBody({ trigger: value }).trigger;
  expect(trigger({ kind: "schedule", cron: "0 9 * * *", tz: "Europe/Berlin" })).toEqual({
    kind: "schedule",
    cron: "0 9 * * *",
    tz: "Europe/Berlin",
  });
  expect(trigger({ kind: "schedule", cron: 42, tz: null })).toEqual({
    kind: "schedule",
    cron: "?",
    tz: "UTC",
  });
  expect(
    trigger({ kind: "webhook", source: "github", events: ["push", 42, null, "issues"] }),
  ).toEqual({ kind: "webhook", source: "github", events: ["push", "issues"] });
  expect(trigger({ kind: "webhook" })).toEqual({ kind: "webhook", source: "?", events: [] });
  for (const raw of [null, "schedule", 42, {}, { kind: "unknown" }]) {
    expect(trigger(raw)).toEqual({ kind: "request" });
  }
});

test("an absent or non-object trigger uses request intent", () => {
  for (const trigger of [null, false, 1, "schedule"])
    expect(intentFromBody({ name: "Example", steps: [], trigger }).trigger).toEqual({
      kind: "request",
    });
});

test("callable trigger metadata is not an object trigger", () => {
  const trigger = Object.assign(() => {}, { kind: "schedule", cron: "0 * * * *", tz: "UTC" });
  expect(intentFromBody({ name: "Example", steps: [], trigger }).trigger).toEqual({
    kind: "request",
  });
});
