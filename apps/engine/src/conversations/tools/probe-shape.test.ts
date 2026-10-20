import { expect, test } from "bun:test";
import { summarizeProbeBody } from "./probe-shape.ts";

test("shape probes reveal fields and types without private values", () => {
  const result = summarizeProbeBody(
    { data: [{ title: "private issue", access_token: "secret" }] },
    "shape",
  );
  expect(result.fields).toContainEqual({ path: "data[0].title", type: "string" });
  expect(JSON.stringify(result)).not.toContain("private issue");
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("sample probes bound values and redact secret fields", () => {
  const result = summarizeProbeBody(
    {
      title: "a".repeat(300),
      access_token: "ghp_sensitive",
      authorization: "Bearer sensitive",
    },
    "sample",
  );
  expect(result.fields).toContainEqual({
    path: "title",
    type: "string",
    example: "a".repeat(120),
  });
  expect(JSON.stringify(result)).not.toContain("ghp_sensitive");
  expect(JSON.stringify(result)).not.toContain("Bearer sensitive");
});
