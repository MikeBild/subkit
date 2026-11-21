import { expect, test } from "bun:test";
import { validateWorkflowDef } from "../core/validator.ts";
import { WorkflowDefSchema } from "../types.ts";

const CONNECTOR = "00000000-0000-4000-8000-000000000001";

function workflow(step: Record<string, unknown>) {
  return {
    name: "retention",
    steps: [{ id: "purge", kind: "request", connector_id: CONNECTOR, ...step }],
  };
}
const messagesFor = (step: Record<string, unknown>) =>
  validateWorkflowDef(workflow(step)).errors.map((error) => `${error.path}: ${error.message}`);

test("the production shape — DELETE at a prefix with the keys in a body — is refused on both counts", () => {
  const messages = messagesFor({
    method: "DELETE",
    path: "v1/sources/",
    body: { items: "${scope.list_sources.data.items}" },
    s3: { scope: { key_prefix: "v1/sources/", max_bytes: 10, max_deletes: 50 } },
  });
  expect(messages.some((m) => m.startsWith("steps.purge.s3.key:"))).toBe(true);
  expect(messages.some((m) => m.startsWith("steps.purge.body:"))).toBe(true);
  expect(messages.join("\n")).toContain("for_each");
});

test("a PUT needs an object key too; a read may still fall back to the path", () => {
  expect(messagesFor({ method: "PUT", path: "reports/a.json", body: "{}", s3: {} })).toEqual(
    expect.arrayContaining([expect.stringContaining("steps.purge.s3.key:")]),
  );
  expect(messagesFor({ method: "GET", path: "reports/a.json", s3: {} })).toEqual([]);
});

test("the per-object removal the driver actually supports is valid", () => {
  expect(
    messagesFor({
      method: "DELETE",
      s3: {
        key: "${input.key}",
        scope: { key_prefix: "v1/sources/", max_bytes: 10, max_deletes: 50 },
      },
    }),
  ).toEqual([]);
});

test("the parse schema stays lenient, so a stored version of the old shape still loads", () => {
  expect(
    WorkflowDefSchema.safeParse(
      workflow({ method: "DELETE", path: "v1/sources/", body: { items: [] }, s3: {} }),
    ).success,
  ).toBe(true);
});
