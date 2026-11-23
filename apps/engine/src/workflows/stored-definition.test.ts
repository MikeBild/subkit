import { expect, test } from "bun:test";
import { executableDefinition, readStoredDefinition } from "./stored-definition.ts";

const request = (id: string) => ({
  id,
  kind: "request",
  method: "GET",
  url: "https://example.test/${item.id}",
});

test("a stored version with a multi-step loop is invalid and says how to rewrite it", () => {
  const dag = {
    name: "stored",
    steps: [
      { id: "each", kind: "loop", over: "rows", body: ["a", "b"] },
      request("a"),
      request("b"),
    ],
  };
  const stored = readStoredDefinition(dag);
  if (!stored.invalid) throw new Error("expected an invalid stored version");
  expect(stored.issues).toEqual([
    {
      path: "steps.0",
      step_id: "each",
      message:
        "The `loop` step kind is retired and this loop cannot be converted automatically: its body has more than one step. Move the body steps into their own workflow and run it once per element with a `call` step that carries `for_each`, or give each body step its own `for_each`.",
    },
  ]);
  expect(() => executableDefinition(dag)).toThrow(
    'step "each", steps.0: The `loop` step kind is retired',
  );
});

test("a convertible stored loop names the for_each to set, and other schema issues stay listed", () => {
  const stored = readStoredDefinition({
    name: "stored",
    steps: [{ id: "each", kind: "loop", over: "rows.data", body: ["a"] }, request("a"), { id: 7 }],
  });
  if (!stored.invalid) throw new Error("expected an invalid stored version");
  expect(stored.issues[0]).toEqual({
    path: "steps.0",
    step_id: "each",
    message:
      'The `loop` step kind is retired. Set `for_each: "(sourceData) => sourceData.rows.data"` on step "a" and remove this step.',
  });
  expect(stored.issues.slice(1).every((issue) => issue.path.startsWith("steps.2"))).toBe(true);
  expect(stored.issues.length).toBeGreaterThan(1);
});

test("a definition in the current format reads as valid", () => {
  const stored = readStoredDefinition({
    name: "current",
    steps: [{ ...request("a"), for_each: "(sourceData) => sourceData.$input.rows" }],
  });
  expect(stored.invalid).toBe(false);
});
