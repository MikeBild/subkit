// The author-declared request boundary, tested on its own before the compiler
// depends on it. The property that matters most is agreement: whatever target
// the review shows a human must be exactly the set of targets dispatch admits.
// Reviewing with `new URL(path, base)` and dispatching through `resolveUrl`
// disagreed for every base_url that carries a path; these tests use such bases
// on purpose, including the production case where the author repeats the base
// prefix and the resolver dedupes it.

import { expect, test } from "bun:test";
import { resolveUrl } from "../connectors/drivers/resolve-url.ts";
import {
  assertRequestBoundary,
  compileRequestBoundary,
  RequestBoundarySchema,
  requestBoundaryTarget,
} from "./request-boundary.ts";
import { RequestStepSchema } from "./types.ts";

const CONNECTOR = "00000000-0000-4000-8000-000000000001";
const BASE = "https://api.example.test/v2";

function step(extra: Record<string, unknown>) {
  return RequestStepSchema.parse({
    id: "call",
    kind: "request",
    connector_id: CONNECTOR,
    ...extra,
  });
}
const release = step({
  method: "POST",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  path: "/sites/${input.site}/releases",
  headers: { "content-type": "application/json" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  body: { reason: "retire ${scope.pick.data.count}", ids: "${scope.pick.data.ids}" },
  boundary: {
    variables: { "input.site": { enum: ["company-cockpit", "blog"] } },
    max_body_bytes: 200,
    max_calls: 1,
  },
});

test("the reviewed target keeps the base path and names the variable", () => {
  const { boundary } = compileRequestBoundary(release, BASE);
  expect(boundary?.origin).toBe("https://api.example.test");
  expect(boundary?.segments).toEqual(["", "v2", "sites", { var: "input.site" }, "releases"]);
  expect(requestBoundaryTarget(boundary!)).toBe(
    "https://api.example.test/v2/sites/{input.site}/releases",
  );
});

test("review and dispatch agree, including when the author repeats the base prefix", () => {
  // Same step authored both ways; `resolveUrl` dedupes the repeated prefix.
  for (const path of [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    "/sites/${input.site}/releases",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    "/v2/sites/${input.site}/releases",
  ]) {
    const { boundary } = compileRequestBoundary(step({ ...release, path }), BASE);
    expect(boundary).toBeDefined();
    for (const site of ["company-cockpit", "blog"]) {
      // Exactly what the HTTP driver would send for this value.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      const url = resolveUrl(BASE, path.replace("${input.site}", site)).toString();
      expect(() =>
        assertRequestBoundary(boundary!, { method: "POST", url, headers: {}, body: { a: 1 } }),
      ).not.toThrow();
    }
  }
});

test("every refusal names its cause", () => {
  const reason = (extra: Record<string, unknown>, base: string | null = BASE) =>
    compileRequestBoundary(step({ ...release, ...extra }), base).refusal;
  expect(reason({ boundary: undefined })).toBe("no_boundary");
  expect(
    compileRequestBoundary(
      step({ method: "GET", s3: { key: "a" }, boundary: release.boundary }),
      BASE,
    ).refusal,
  ).toBe("not_http_step");
  expect(
    reason({
      pagination: {
        strategy: "cursor",
        cursor_request_param: "cursor",
        cursor_response_path: "$.next",
      },
    }),
  ).toBe("pagination_unsupported");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  expect(reason({ query: { since: "${input.since}" } })).toBe("query_placeholder_unsupported");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  expect(reason({ headers: { "x-tenant": "${input.tenant}" } })).toBe("runtime_header");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  expect(reason({ path: "/properties/${input.id}:run" })).toBe("partial_segment_placeholder");
  expect(reason({ path: "/sites/a?x=1" })).toBe("path_unsupported");
  expect(reason({ path: "/sites/a%2Fb" })).toBe("path_unsupported");
  // A rule for a placeholder that is not there, and a placeholder with no rule.
  expect(reason({ path: "/sites/fixed/releases" })).toBe("variables_mismatch");
  expect(reason({ boundary: { variables: {}, max_body_bytes: 10, max_calls: 1 } })).toBe(
    "variables_mismatch",
  );
  expect(reason({ method: "DELETE" })).toBe("delete_requires_destructive");
  expect(reason({}, null)).toBe("target_unresolved");
  // The dedupe looks at the leading segments; a variable there would let a
  // runtime value decide how the URL is assembled.
  expect(
    reason({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      path: "/${input.site}/releases",
    }),
  ).toBe("variable_in_base_prefix");
  // Nothing refused: the happy path compiles.
  expect(reason({})).toBeUndefined();
});

test("a removal has to be declared destructive, on the schema itself", () => {
  const { boundary } = compileRequestBoundary(
    step({
      ...release,
      method: "DELETE",
      body: undefined,
      boundary: { ...release.boundary, destructive: true },
    }),
    BASE,
  );
  expect(boundary?.destructive).toBe(true);
  // A hand-assembled DELETE boundary without the flag does not parse anywhere.
  const { destructive: _flag, ...unflagged } = boundary!;
  expect(RequestBoundarySchema.safeParse(unflagged).success).toBe(false);
});

test("dispatch denies everything outside the reviewed statement", () => {
  const { boundary } = compileRequestBoundary(release, BASE);
  const ok = {
    method: "POST",
    url: "https://api.example.test/v2/sites/blog/releases",
    headers: { "content-type": "application/json" },
    body: { reason: "retire 3", ids: ["a", "b", "c"] },
  };
  expect(() => assertRequestBoundary(boundary!, ok)).not.toThrow();
  for (const change of [
    { url: "https://api.example.test/v2/sites/other-site/releases" }, // not an approved value
    { url: "https://api.example.test/sites/blog/releases" }, // base path dropped
    { url: "https://evil.example.test/v2/sites/blog/releases" }, // other origin
    { url: "https://api.example.test/v2/sites/blog/releases/extra" }, // longer path
    { url: "https://api.example.test/v2/sites/blog%2F..%2Fadmin/releases" }, // encoded traversal
    { url: "https://api.example.test/v2/sites/blog/releases?force=1" }, // unreviewed query
    { url: "https://user:pw@api.example.test/v2/sites/blog/releases" },
    { method: "PUT" },
    { body: { blob: "x".repeat(400) } }, // over max_body_bytes
    { unsupported_body: true }, // not measurable → denied, never skipped
  ])
    expect(() => assertRequestBoundary(boundary!, { ...ok, ...change })).toThrow(
      "reviewed target, method or size boundary",
    );
});

test("a static query is part of the boundary; a GET may not carry a body", () => {
  const { boundary } = compileRequestBoundary(
    step({
      method: "GET",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      path: "/spaces/${item.slug}/proposals",
      query: { status: "pending" },
      boundary: {
        variables: { "item.slug": { enum: ["wikikit", "blog-de"] } },
        max_body_bytes: 0,
        max_calls: 6,
      },
    }),
    BASE,
  );
  expect(boundary?.query.fixed).toEqual({ status: "pending" });
  const ok = {
    method: "GET",
    url: "https://api.example.test/v2/spaces/wikikit/proposals?status=pending",
    headers: {},
    body: null,
  };
  expect(() => assertRequestBoundary(boundary!, ok)).not.toThrow();
  for (const change of [
    { url: ok.url.replace("pending", "approved") },
    { url: `${ok.url}&limit=5` },
    { url: ok.url.replace("?status=pending", "") },
    { url: `${ok.url}&status=pending` }, // duplicate key
    { body: "{}" },
  ])
    expect(() => assertRequestBoundary(boundary!, { ...ok, ...change })).toThrow();
});

test("a value that could change the route never gets as far as a boundary", () => {
  // The rule is part of the step schema, so an unusable value is refused where
  // the workflow is parsed — before any compile, review or dispatch.
  for (const value of ["a/b", "..", "has space", "x?y", "", "a%2Fb"])
    expect(
      RequestStepSchema.safeParse({
        ...release,
        boundary: {
          variables: { "input.site": { enum: [value] } },
          max_body_bytes: 10,
          max_calls: 1,
        },
      }).success,
    ).toBe(false);
});

test("a refused `destructive: false` says to omit the key, not to flip it", () => {
  // The stock message was "expected true", and an author who had written
  // `false` on a plain POST changed it to `true` to get past the validator.
  const parsed = RequestStepSchema.safeParse({
    ...release,
    boundary: { ...release.boundary, destructive: false },
  });
  expect(parsed.success).toBe(false);
  const message = parsed.success ? "" : parsed.error.issues.map((issue) => issue.message).join(" ");
  expect(message).toContain("OMIT the key");
  expect(message).not.toBe("Invalid input: expected true");
  // Omitting it is what parses.
  expect(RequestStepSchema.safeParse(release).success).toBe(true);
});
