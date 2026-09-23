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
  describeRequestBoundaryViolation,
  RequestBoundarySchema,
  requestBoundaryTarget,
  requestBoundaryViolation,
  VALUE_CLASSES,
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
  // A paginating step without a page cap makes an unreviewable number of
  // requests; one that pages through the body is not a key set at all.
  expect(
    reason({
      pagination: {
        strategy: "cursor",
        cursor_request_param: "cursor",
        cursor_response_path: "$.next",
      },
    }),
  ).toBe("pagination_unbounded");
  expect(
    reason({
      pagination: {
        strategy: "cursor",
        cursor_request_param: "cursor",
        cursor_response_path: "$.next",
        max_pages: 5,
        parameter_location: "body",
      },
    }),
  ).toBe("pagination_unsupported");
  // A query value may vary only as a WHOLE placeholder with a rule of its own.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  expect(reason({ query: { since: "from-${input.since}" } })).toBe("query_placeholder_unsupported");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  expect(reason({ query: { since: "${input.since}" } })).toBe("variables_mismatch");
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
  for (const value of [
    "a/b",
    "..",
    "has space",
    "x?y",
    "x#y",
    "",
    // An escape is allowed; one that smuggles a traversal, a control character
    // or a backslash past a server that decodes before routing is not.
    "%2e%2e",
    ".%2E",
    "%2E",
    "a%2F..%2Fb",
    "%00",
    "%0A",
    "%7F",
    "a%5Cb",
    "%zz",
    "%2",
    "%C0%AF",
  ])
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

// ── Values that cannot be listed: classes, and query values that vary ────────

const stats = step({
  method: "GET",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  path: "/sites/${input.site}/stats/${item.id}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  query: { from: "${scope.window.data.start}", to: "${scope.window.data.end}", tz: "UTC" },
  boundary: {
    variables: {
      "input.site": { enum: ["blog"] },
      "item.id": { class: "uuid" },
      "scope.window.data.start": { class: "timestamp" },
      "scope.window.data.end": { class: "timestamp" },
    },
    max_body_bytes: 0,
    max_calls: 30,
  },
});
const ID = "3f2c1b9a-7d4e-4c1a-9b8e-2a6f0c5d1e77";
const statsUrl = (id: string, query: string) =>
  `https://api.example.test/v2/sites/blog/stats/${id}?${query}`;
const GOOD_QUERY = "from=2026-09-20T00%3A00%3A00.000Z&to=2026-09-21T00%3A00%3A00Z&tz=UTC";

test("the class patterns are pinned: a live approval must never change meaning", () => {
  expect(Object.fromEntries(Object.entries(VALUE_CLASSES).map(([k, v]) => [k, v.source]))).toEqual({
    identifier: "^[A-Za-z0-9_-]{1,200}$",
    uuid: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
    integer: "^(0|[1-9][0-9]{0,18})$",
    date: "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$",
    timestamp: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$",
    file_name: "^[A-Za-z0-9_-]{1,200}\\.[A-Za-z0-9]{1,16}$",
  });
});

test("a file name stays one segment and cannot walk out of its folder", () => {
  // The class exists because a content repository addresses a file by name;
  // without it the only bounded shape was an enum of every file that would
  // ever exist. It must not become a way to reach a sibling directory.
  const ok = VALUE_CLASSES.file_name;
  expect(ok.test("my-essay.md")).toBe(true);
  expect(ok.test("post_2026.mdx")).toBe(true);
  for (const bad of [
    "..",
    "../secret.md",
    "a/b.md",
    ".env",
    "essay..md",
    "essay.md.bak",
    "essay.",
    ".md",
    "essay%2Fother.md",
    "essay .md",
  ]) {
    expect(ok.test(bad)).toBe(false);
  }
});

test("review and dispatch agree on a class segment and varying query values", () => {
  const { boundary, refusal } = compileRequestBoundary(stats, BASE);
  expect(refusal).toBeUndefined();
  expect(boundary?.query).toEqual({
    fixed: { tz: "UTC" },
    variable: [
      { key: "from", var: "scope.window.data.start" },
      { key: "to", var: "scope.window.data.end" },
    ],
  });
  const ok = { method: "GET", url: statsUrl(ID, GOOD_QUERY), headers: {}, body: null };
  expect(() => assertRequestBoundary(boundary!, ok)).not.toThrow();
});

test("a class denies everything that is not a member, in the path", () => {
  const { boundary } = compileRequestBoundary(stats, BASE);
  for (const id of [
    "", // empty
    "..",
    "3f2c1b9a-7d4e-4c1a-9b8e-2a6f0c5d1e7", // 35 characters
    "{3f2c1b9a-7d4e-4c1a-9b8e-2a6f0c5d1e77}",
    "3f2c1b9a-7d4e-0c1a-9b8e-2a6f0c5d1e77", // version nibble 0
    `${ID}%2F..`,
    `${ID}/extra`,
    "a%2Fb",
    "a b",
  ])
    expect(() =>
      assertRequestBoundary(boundary!, {
        method: "GET",
        url: statsUrl(id, GOOD_QUERY),
        headers: {},
        body: null,
      }),
    ).toThrow();
});

test("a varying query keeps an exact key set and holds each value to its rule", () => {
  const { boundary } = compileRequestBoundary(stats, BASE);
  for (const query of [
    `${GOOD_QUERY}&admin=1`, // extra key
    "from=2026-09-20T00%3A00%3A00Z&tz=UTC", // missing key
    `${GOOD_QUERY}&from=2026-09-19T00%3A00%3A00Z`, // duplicate key
    GOOD_QUERY.replace("from=", "From="), // another key
    GOOD_QUERY.replace("tz=UTC", "tz=CET"), // changed fixed value
    GOOD_QUERY.replace("2026-09-20T00%3A00%3A00.000Z", ""), // empty value
    GOOD_QUERY.replace("2026-09-20T00%3A00%3A00.000Z", "2026-09-20T00%3A00%3A00%2B02%3A00"), // offset
    GOOD_QUERY.replace("2026-09-20T00%3A00%3A00.000Z", "2026-09-20"), // a date is not a timestamp
    // One value that tries to be two parameters stays one key and fails its class.
    GOOD_QUERY.replace("2026-09-20T00%3A00%3A00.000Z", "2026-09-20T00%3A00%3A00Z%26admin%3D1"),
  ])
    expect(() =>
      assertRequestBoundary(boundary!, {
        method: "GET",
        url: statsUrl(ID, query),
        headers: {},
        body: null,
      }),
    ).toThrow("reviewed target, method or size boundary");
});

test("the other classes accept their members and nothing near them", () => {
  const compileWith = (cls: string) =>
    compileRequestBoundary(
      step({
        method: "GET",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        path: "/things/${item.value}",
        boundary: { variables: { "item.value": { class: cls } }, max_body_bytes: 0, max_calls: 5 },
      }),
      BASE,
    ).boundary!;
  const passes = (cls: string, value: string) => {
    try {
      assertRequestBoundary(compileWith(cls), {
        method: "GET",
        url: `https://api.example.test/v2/things/${value}`,
        headers: {},
        body: null,
      });
      return true;
    } catch {
      return false;
    }
  };
  expect(["0", "42", "9007199254740993"].every((v) => passes("integer", v))).toBe(true);
  expect(["007", "-1", "1.5", "1".repeat(20), "１２３"].some((v) => passes("integer", v))).toBe(
    false,
  );
  expect(passes("date", "2026-02-28")).toBe(true);
  expect(["2026-13-01", "2026-1-1", "2026-02-28T00:00:00Z"].some((v) => passes("date", v))).toBe(
    false,
  );
  expect(passes("identifier", "blog-de_2")).toBe(true);
  expect(["a.b", "a~b", "x".repeat(201)].some((v) => passes("identifier", v))).toBe(false);
});

test("a removal may only vary over listed values", () => {
  const removal = step({
    method: "DELETE",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    path: "/things/${item.id}",
    boundary: {
      variables: { "item.id": { class: "uuid" } },
      max_body_bytes: 0,
      max_calls: 1,
      destructive: true,
    },
  });
  expect(compileRequestBoundary(removal, BASE).refusal).toBe("delete_requires_enum");
});

// ── Segments an API spells with `:` or percent-escapes ───────────────────────

const ENCODED_SITE = "https%3A%2F%2Fexample.com%2F";
const searchQuery = step({
  method: "POST",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  path: "/sites/${scope.target.data.site}/query/${scope.target.data.report}",
  body: { rows: 10 },
  boundary: {
    variables: {
      "scope.target.data.site": { enum: [ENCODED_SITE, "sc-domain%3Aexample.com"] },
      "scope.target.data.report": { enum: ["123456789:runReport"] },
    },
    max_body_bytes: 100,
    max_calls: 2,
  },
});

test("an escaped or colon-bearing segment is compared exactly as it is sent", () => {
  const { boundary, refusal } = compileRequestBoundary(searchQuery, BASE);
  expect(refusal).toBeUndefined();
  const send = (site: string, report = "123456789:runReport") => ({
    method: "POST",
    url: `https://api.example.test/v2/sites/${site}/query/${report}`,
    headers: {},
    body: { rows: 10 },
  });
  expect(() => assertRequestBoundary(boundary!, send(ENCODED_SITE))).not.toThrow();
  expect(() => assertRequestBoundary(boundary!, send("sc-domain%3Aexample.com"))).not.toThrow();
  for (const site of [
    "https%3a%2f%2fexample.com%2f", // other hex case: not the reviewed bytes
    "https:%2F%2Fexample.com%2F", // partly decoded
    "https%253A%252F%252Fexample.com%252F", // double encoded
    "https%3A%2F%2Fevil.example%2F",
    "https://example.com/", // decoded: more segments
    `${ENCODED_SITE}%2F%2E%2E`,
  ])
    expect(() => assertRequestBoundary(boundary!, send(site))).toThrow();
  for (const report of [
    "123456789:runReportX",
    "999:runReport",
    "123456789%3ArunReport",
    ":runReport",
  ])
    expect(() => assertRequestBoundary(boundary!, send(ENCODED_SITE, report))).toThrow();
});

test("a value that would be read as a URL scheme is caught at review, not at dispatch", () => {
  const leading = step({
    method: "GET",
    // No leading slash: the first segment is the variable itself.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    path: "${item.account}/insights",
    boundary: {
      variables: { "item.account": { enum: ["do:team:0e489f44-ea42-4bd8-8102-3e3e00827db7"] } },
      max_body_bytes: 0,
      max_calls: 1,
    },
  });
  expect(compileRequestBoundary(leading, "https://api.example.test").refusal).toBe(
    "enum_value_unroutable",
  );
  // The same value behind a literal segment routes where it was reviewed.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  const behind = step({ ...leading, path: "/billing/${item.account}/insights" });
  expect(compileRequestBoundary(behind, "https://api.example.test").refusal).toBeUndefined();
});

test("a refused query says which parameter, and for a declared variable which value and rule", () => {
  // An author who declared a time window as `timestamp` while the API takes
  // unix seconds was told only that "the query differs", and guessed.
  const { boundary } = compileRequestBoundary(stats, BASE);
  const describe = (query: string) => {
    const violation = requestBoundaryViolation(boundary!, {
      method: "GET",
      url: statsUrl(ID, query),
      headers: {},
      body: null,
    });
    return violation ? describeRequestBoundaryViolation(violation) : "";
  };
  expect(describe(GOOD_QUERY.replace("2026-09-20T00%3A00%3A00.000Z", "1789026900"))).toBe(
    'the query value `from` is "1789026900", which is outside its rule (class timestamp)',
  );
  expect(describe(GOOD_QUERY.replace("tz=UTC", "tz=CET"))).toContain(
    "`tz` no longer has the fixed value",
  );
  expect(describe("from=2026-09-20T00%3A00%3A00Z&tz=UTC")).toContain(
    "`to` the step declares is missing",
  );
  // A key the step does not declare is named WITHOUT its value: a connector
  // may have put a credential there.
  const extra = describe(`${GOOD_QUERY}&api_key=s3cr3t-value`);
  expect(extra).toContain("`api_key`");
  expect(extra).not.toContain("s3cr3t-value");
});

test("a rule keyed by a parameter name is refused with what a key is", () => {
  const parsed = RequestStepSchema.safeParse({
    ...stats,
    boundary: { variables: { start: { class: "integer" } }, max_body_bytes: 0, max_calls: 1 },
  });
  expect(parsed.success).toBe(false);
  const message = parsed.success ? "" : parsed.error.issues.map((issue) => issue.message).join(" ");
  expect(message).toContain("placeholder expression without its");
  expect(message).toContain("scope.window.data.start");
});

test("a JS selector may hold a template literal; a real runtime value elsewhere still refuses", () => {
  // `for_each` and `data_selector` are evaluated in the sandbox, never
  // placeholder-substituted. Scanning them for `${` refused a correct step and
  // told its author to make a selector "a literal".
  const iterated = step({
    ...release,
    for_each:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a JS template literal, not a placeholder
      "(scope) => scope.plan.data.items.map((i) => ({ title: `Report ${scope.window.data.start}` }))",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a JS template literal, not a placeholder
    data_selector: "(out) => ({ id: `${out.id}` })",
    boundary: { ...release.boundary, max_calls: 20 },
  });
  expect(compileRequestBoundary(iterated, BASE).refusal).toBeUndefined();
  // A runtime value in a field the engine DOES substitute is still refused.
  expect(
    compileRequestBoundary(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      step({ ...release, idempotency_key: "${input.site}" }),
      BASE,
    ).refusal,
  ).toBe("runtime_value_outside_path_and_body");
});

// A read the provider hands out one page at a time.
//
// Refusing these outright meant a step that reads one page's blocks — fixed
// target, one uuid, no body — could carry no boundary at all, and its workflow
// could never be approved. No authoring fixes that: the follow-up requests come
// from the engine, not from the definition. What is reviewable is which keys the
// engine moves and how many requests there can be, and the step says both.
const paged = step({
  method: "GET",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  path: "/blocks/${input.page_id}/children",
  query: { page_size: 100 },
  pagination: {
    strategy: "cursor",
    cursor_request_param: "start_cursor",
    cursor_response_path: "$.next_cursor",
    max_pages: 12,
  },
  boundary: {
    variables: { "input.page_id": { class: "uuid" } },
    max_body_bytes: 0,
    max_calls: 1,
  },
});
const PAGE = "00000000-0000-4000-8000-0000000000aa";

test("a paginating read carries a boundary, and says how many requests that is", () => {
  const { boundary, refusal } = compileRequestBoundary(paged, BASE);
  expect(refusal).toBeUndefined();
  expect(boundary?.pagination).toEqual({ params: ["start_cursor"], max_requests: 12 });
  expect(requestBoundaryTarget(boundary!)).toBe(
    "https://api.example.test/v2/blocks/{input.page_id}/children",
  );
});

test("the follow-up request is admitted, and only because of its paging key", () => {
  const { boundary } = compileRequestBoundary(paged, BASE);
  const url = (extra: string) =>
    resolveUrl(BASE, `/blocks/${PAGE}/children?page_size=100${extra}`).toString();
  const request = (extra: string) => ({
    method: "GET",
    url: url(extra),
    headers: {},
    body: null,
  });
  // First page, then the one the provider's own answer asked for.
  expect(requestBoundaryViolation(boundary!, request(""))).toBeNull();
  expect(requestBoundaryViolation(boundary!, request("&start_cursor=eyJib"))).toBeNull();
  // Any other key is still outside the boundary — the exemption is by name.
  const other = requestBoundaryViolation(boundary!, request("&filter=all"));
  expect(other).toEqual({ kind: "query", detail: { reason: "unexpected_key", key: "filter" } });
  expect(describeRequestBoundaryViolation(other!)).toContain("filter");
  // And the exemption does not loosen the path.
  expect(
    requestBoundaryViolation(boundary!, {
      method: "GET",
      url: resolveUrl(BASE, "/blocks/not-a-uuid/children?page_size=100").toString(),
      headers: {},
      body: null,
    }),
  ).not.toBeNull();
});

test("a step that does not paginate carries no pagination field at all", () => {
  // Present-but-undefined and absent are different bytes to the digest, and a
  // moved digest revokes every live approval of that workflow.
  const { boundary } = compileRequestBoundary(release, BASE);
  expect("pagination" in (boundary as object)).toBe(false);
});

test("a paging key that is also the step's own query key is refused", () => {
  expect(
    compileRequestBoundary(
      step({
        method: "GET",
        path: "/items",
        query: { cursor: "start" },
        pagination: {
          strategy: "cursor",
          cursor_request_param: "cursor",
          cursor_response_path: "$.next",
          max_pages: 3,
        },
        boundary: { variables: {}, max_body_bytes: 0, max_calls: 1 },
      }),
      BASE,
    ).refusal,
  ).toBe("pagination_param_conflict");
});
