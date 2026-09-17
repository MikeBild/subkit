import { expect, test } from "bun:test";
import { assertReadPath, readPathBoundary, readPathTarget } from "../read-path-boundary.ts";
import { WorkflowDefSchema } from "../types.ts";

const request = (overrides: Record<string, unknown> = {}) => {
  const step = WorkflowDefSchema.parse({
    name: "Resource report",
    steps: [
      {
        id: "read",
        connector_id: "00000000-0000-4000-8000-000000000001",
        kind: "request",
        method: "GET",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow runtime expression
        path: "/v2/projects/${item.id}/resources",
        ...overrides,
      },
    ],
  }).steps[0];
  if (step?.kind !== "request") throw new Error("missing request");
  return step;
};
const base = "https://api.example.test";
test("review bounds a variable resource identifier to one read-only collection", () => {
  const boundary = readPathBoundary(request(), base);
  expect(boundary).toEqual({
    origin: base,
    segments: ["", "v2", "projects", null, "resources"],
    search: "",
  });
  if (!boundary) throw new Error("missing boundary");
  expect(readPathTarget(boundary)).toBe(`${base}/v2/projects/{ID}/resources`);
  expect(() =>
    assertReadPath(boundary, {
      method: "GET",
      url: `${base}/v2/projects/project-123/resources`,
      headers: {},
      body: null,
    }),
  ).not.toThrow();
  for (const url of [
    "https://evil.test/v2/projects/project-123/resources",
    `${base}/v2/projects/project-123/credentials`,
    `${base}/v2/projects/project-123/resources?include=secrets`,
    `${base}/v2/projects/project%2F123/resources`,
    `${base}/v2/projects/project%252F123/resources`,
    `${base}/v2/projects//resources`,
    `${base}/v2/projects/project-123/resources#fragment`,
    "https://user@api.example.test/v2/projects/project-123/resources",
  ])
    expect(() =>
      assertReadPath(boundary, { method: "GET", url, headers: {}, body: null }),
    ).toThrow();
  expect(() =>
    assertReadPath(boundary, {
      method: "POST",
      url: `${base}/v2/projects/project-123/resources`,
      headers: {},
      body: null,
    }),
  ).toThrow();
  expect(() => assertReadPath(boundary, undefined)).toThrow();
});
test("variable writes, hosts, partial segments and unrelated dynamic fields stay unsupported", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow runtime expressions
  const runtime = "${item.id}";
  for (const overrides of [
    { method: "POST" },
    { body: { data: runtime } },
    { headers: { Authorization: runtime } },
    { path: `https://${runtime}/resources` },
    { path: `/${runtime}/resources` },
    { path: `/v2/projects/prefix-${runtime}/resources` },
    { query: { id: runtime } },
    { path: `/v2/projects/${runtime}/resources?key=${runtime}` },
    { path: `/v2/projects/${runtime}/resources`, url: "https://other.test" },
  ])
    expect(readPathBoundary(request(overrides), base)).toBeNull();
});
