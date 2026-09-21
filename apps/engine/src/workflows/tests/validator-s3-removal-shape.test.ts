// A storage write or removal addresses ONE object.
//
// A generated retention workflow aimed each DELETE at a folder prefix (via
// `step.path`) and put the keys it meant to remove into a `body`. It validated
// with zero errors and previewed green, because the parse schema lets
// `step.path` stand in for `s3.key` and relates nothing to `body`. At run time
// the driver ignores a DELETE body and removes the literal path: every step
// would have deleted at most a folder marker, been answered 204, and the
// workflow would have reported a plausible count while removing nothing.
//
// The rules live in the authoring validator, not the parse schema: a stored
// version must keep parsing at run time, but a new draft of this shape is
// refused where its author can still fix it.

import { expect, test } from "bun:test";
import { WorkflowDefSchema } from "../types.ts";
import { validateWorkflowDef } from "../validator.ts";

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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    body: { items: "${scope.list_sources.data.items}" },
    s3: { scope: { key_prefix: "v1/sources/", max_bytes: 10, max_deletes: 50 } },
  });
  expect(messages.some((m) => m.startsWith("steps.purge.s3.key:"))).toBe(true);
  expect(messages.some((m) => m.startsWith("steps.purge.body:"))).toBe(true);
  // The message has to say what to do instead, or the author is left guessing.
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
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        key: "${input.key}",
        scope: { key_prefix: "v1/sources/", max_bytes: 10, max_deletes: 50 },
      },
    }),
  ).toEqual([]);
});

test("the parse schema stays lenient, so a stored version of the old shape still loads", () => {
  // Tightening the schema would break admission and execution of any version
  // already saved with this shape; only authoring refuses it.
  expect(
    WorkflowDefSchema.safeParse(
      workflow({ method: "DELETE", path: "v1/sources/", body: { items: [] }, s3: {} }),
    ).success,
  ).toBe(true);
});
