import { expect, test } from "bun:test";
import { resolveUrl } from "../connectors/drivers/resolve-url.ts";
import { canonicalWorkflowJson, workflowJsonDigest } from "./canonical-json.ts";
import {
  assertRequestBoundary,
  compileRequestBoundary,
  describeRequestBoundaryViolation,
  pathValueAllowed,
  RequestBoundarySchema,
  requestBoundaryTarget,
  requestBoundaryViolation,
  VALUE_CLASSES,
} from "./request-boundary.ts";
import { RequestStepSchema, WorkflowDefSchema } from "./types.ts";

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
  for (const path of [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    "/sites/${input.site}/releases",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    "/v2/sites/${input.site}/releases",
  ]) {
    const { boundary } = compileRequestBoundary(step({ ...release, path }), BASE);
    expect(boundary).toBeDefined();
    for (const site of ["company-cockpit", "blog"]) {
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
  expect(reason({ path: "/sites/fixed/releases" })).toBe("variables_mismatch");
  expect(reason({ boundary: { variables: {}, max_body_bytes: 10, max_calls: 1 } })).toBe(
    "variables_mismatch",
  );
  expect(reason({ method: "DELETE" })).toBe("delete_requires_destructive");
  expect(reason({}, null)).toBe("target_unresolved");
  expect(
    reason({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      path: "/${input.site}/releases",
    }),
  ).toBe("variable_in_base_prefix");
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
    { url: "https://api.example.test/v2/sites/other-site/releases" },
    { url: "https://api.example.test/sites/blog/releases" },
    { url: "https://evil.example.test/v2/sites/blog/releases" },
    { url: "https://api.example.test/v2/sites/blog/releases/extra" },
    { url: "https://api.example.test/v2/sites/blog%2F..%2Fadmin/releases" },
    { url: "https://api.example.test/v2/sites/blog/releases?force=1" },
    { url: "https://user:pw@api.example.test/v2/sites/blog/releases" },
    { method: "PUT" },
    { body: { blob: "x".repeat(400) } },
    { unsupported_body: true },
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
    { url: `${ok.url}&status=pending` },
    { body: "{}" },
  ])
    expect(() => assertRequestBoundary(boundary!, { ...ok, ...change })).toThrow();
});

test("a value that could change the route never gets as far as a boundary", () => {
  for (const value of [
    "a/b",
    "..",
    "has space",
    "x?y",
    "x#y",
    "",
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
  const parsed = RequestStepSchema.safeParse({
    ...release,
    boundary: { ...release.boundary, destructive: false },
  });
  expect(parsed.success).toBe(false);
  const message = parsed.success ? "" : parsed.error.issues.map((issue) => issue.message).join(" ");
  expect(message).toContain("OMIT the key");
  expect(message).not.toBe("Invalid input: expected true");
  expect(RequestStepSchema.safeParse(release).success).toBe(true);
});

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
    timestamp_range: "^>=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$",
    file_name: "^[A-Za-z0-9_-]{1,200}\\.[A-Za-z0-9]{1,16}$",
    path: "^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*(?:\\/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*)*$",
  });
});

test("the path class refuses what would make a path mean something else", () => {
  const ok = (value: string) => pathValueAllowed(value);
  expect(ok("")).toBe(true);
  expect(ok("/")).toBe(true);
  expect(ok("de/datenstand/")).toBe(true);
  expect(ok("robots.txt")).toBe(true);
  expect(ok("a%20b/c")).toBe(true);
  expect(ok("https://evil.test/x")).toBe(false);
  expect(ok("//evil.test/x")).toBe(false);
  expect(ok("a:b")).toBe(false);
  expect(ok("../secret")).toBe(false);
  expect(ok("a/../../b")).toBe(false);
  expect(ok("%2e%2e/secret")).toBe(false);
  expect(ok("a%2Fb")).toBe(false);
  expect(ok("a\\b")).toBe(false);
  expect(ok("a".repeat(1025))).toBe(false);
});

test("a file name stays one segment and cannot walk out of its folder", () => {
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
    "",
    "..",
    "3f2c1b9a-7d4e-4c1a-9b8e-2a6f0c5d1e7",
    "{3f2c1b9a-7d4e-4c1a-9b8e-2a6f0c5d1e77}",
    "3f2c1b9a-7d4e-0c1a-9b8e-2a6f0c5d1e77",
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
    `${GOOD_QUERY}&admin=1`,
    "from=2026-09-20T00%3A00%3A00Z&tz=UTC",
    `${GOOD_QUERY}&from=2026-09-19T00%3A00%3A00Z`,
    GOOD_QUERY.replace("from=", "From="),
    GOOD_QUERY.replace("tz=UTC", "tz=CET"),
    GOOD_QUERY.replace("2026-09-20T00%3A00%3A00.000Z", ""),
    GOOD_QUERY.replace("2026-09-20T00%3A00%3A00.000Z", "2026-09-20T00%3A00%3A00%2B02%3A00"),
    GOOD_QUERY.replace("2026-09-20T00%3A00%3A00.000Z", "2026-09-20"),
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

test("a removal of the authenticated caller's own record is bound to the caller", () => {
  const removal = step({
    method: "DELETE",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    path: "/auth/v1/admin/users/${caller.subject}",
    boundary: {
      variables: { "caller.subject": { caller_bound: true } },
      max_body_bytes: 0,
      max_calls: 1,
      destructive: true,
    },
  });
  const { boundary, refusal } = compileRequestBoundary(removal, "https://auth.example.test");
  expect(refusal).toBeUndefined();
  const subject = "6f1c2a8e-4b1d-4c55-9a77-1f0e2d3c4b5a";
  const send = (id: string) => ({
    method: "DELETE",
    url: `https://auth.example.test/auth/v1/admin/users/${id}`,
    headers: {},
    body: null,
  });
  expect(requestBoundaryViolation(boundary!, send(subject))).toBeNull();
  expect(requestBoundaryViolation(boundary!, send("..%2F..%2Fsettings"))).toMatchObject({
    kind: "target",
  });
});

test("caller_bound belongs only to caller expressions and a value class on DELETE stays refused", () => {
  const classOnDelete = step({
    method: "DELETE",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    path: "/users/${caller.subject}",
    boundary: {
      variables: { "caller.subject": { class: "uuid" } },
      max_body_bytes: 0,
      max_calls: 1,
      destructive: true,
    },
  });
  expect(compileRequestBoundary(classOnDelete, BASE).refusal).toBe("caller_bound_mismatch");
  const inputBound = step({
    method: "DELETE",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    path: "/users/${input.user}",
    boundary: {
      variables: { "input.user": { caller_bound: true } },
      max_body_bytes: 0,
      max_calls: 1,
      destructive: true,
    },
  });
  expect(compileRequestBoundary(inputBound, BASE).refusal).toBe("caller_bound_mismatch");
});

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
    "https%3a%2f%2fexample.com%2f",
    "https:%2F%2Fexample.com%2F",
    "https%253A%252F%252Fexample.com%252F",
    "https%3A%2F%2Fevil.example%2F",
    "https://example.com/",
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
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  const behind = step({ ...leading, path: "/billing/${item.account}/insights" });
  expect(compileRequestBoundary(behind, "https://api.example.test").refusal).toBeUndefined();
});

test("a refused query says which parameter, and for a declared variable which value and rule", () => {
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
  expect(
    compileRequestBoundary(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      step({ ...release, idempotency_key: "${input.site}" }),
      BASE,
    ).refusal,
  ).toBe("runtime_value_outside_path_and_body");
});

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
  expect(requestBoundaryViolation(boundary!, request(""))).toBeNull();
  expect(requestBoundaryViolation(boundary!, request("&start_cursor=eyJib"))).toBeNull();
  const other = requestBoundaryViolation(boundary!, request("&filter=all"));
  expect(other).toEqual({ kind: "query", detail: { reason: "unexpected_key", key: "filter" } });
  expect(describeRequestBoundaryViolation(other!)).toContain("filter");
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

// biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
const ROUTE_PATH = "${item.path}";
const routeStep = (over: Record<string, unknown> = {}) =>
  step({
    method: "GET",
    path: ROUTE_PATH,
    boundary: {
      variables: { "item.path": { class: "path" } },
      max_body_bytes: 0,
      max_calls: 40,
      ...over,
    },
  });

test("a step that varies the whole path can be bounded at all", () => {
  const { boundary, refusal } = compileRequestBoundary(routeStep(), "https://www.example.test");
  expect(refusal).toBeUndefined();
  expect(boundary?.origin).toBe("https://www.example.test");
  expect(requestBoundaryTarget(boundary!)).toContain("{item.path}");

  const allow = (url: string) =>
    requestBoundaryViolation(boundary!, { method: "GET", url, headers: {}, body: null }) === null;
  expect(allow("https://www.example.test/")).toBe(true);
  expect(allow("https://www.example.test/robots.txt")).toBe(true);
  expect(allow("https://www.example.test/de/datenstand/")).toBe(true);
  expect(allow("https://evil.test/de/")).toBe(false);
  expect(allow("https://www.example.test/deep/route/here")).toBe(true);
  expect(allow("https://www.example.test/a/../../secret")).toBe(true);
  expect(allow("https://www.example.test/a%2Fb")).toBe(false);
});

test("a connector whose base carries a path cannot take a whole-path rule yet", () => {
  expect(compileRequestBoundary(routeStep(), BASE).refusal).toBe("variable_in_base_prefix");
  expect(compileRequestBoundary(routeStep(), "https://www.example.test").refusal).toBeUndefined();
});

test("a whole-path rule is refused anywhere but the last path position", () => {
  expect(
    compileRequestBoundary(
      step({
        method: "GET",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        path: "/sites/${input.site}/releases",
        boundary: {
          variables: { "input.site": { class: "path" } },
          max_body_bytes: 0,
          max_calls: 1,
        },
      }),
      BASE,
    ).refusal,
  ).toBe("path_class_misplaced");
  expect(
    compileRequestBoundary(
      step({
        method: "GET",
        path: "/sites",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        query: { q: "${input.term}" },
        boundary: {
          variables: { "input.term": { class: "path" } },
          max_body_bytes: 0,
          max_calls: 1,
        },
      }),
      BASE,
    ).refusal,
  ).toBe("path_class_misplaced");
});

test("a whole-path rule does not widen a single approved segment", () => {
  const { boundary } = compileRequestBoundary(routeStep(), "https://www.example.test");
  const forged = { ...boundary!, segments: [...boundary!.segments, "tail"] };
  expect(
    requestBoundaryViolation(forged, {
      method: "GET",
      url: "https://www.example.test/a%2Fb/tail",
      headers: {},
      body: null,
    }),
  ).not.toBeNull();
});

test("a boundary approved before this class existed parses to the same bytes", () => {
  const stored = {
    base_url: BASE,
    method: "POST",
    origin: "https://api.example.test",
    segments: ["", "v2", "sites", { var: "input.site" }, "releases"],
    variables: { "input.site": { enum: ["company-cockpit", "blog"] } },
    query: { fixed: {}, variable: [] },
    max_body_bytes: 200,
    max_calls: 1,
  };
  const parsed = RequestBoundarySchema.parse(stored);
  expect(canonicalWorkflowJson(parsed)).toBe(canonicalWorkflowJson(stored));
});

const linked = (over: Record<string, unknown> = {}) =>
  step({
    method: "GET",
    path: "/repos/MikeBild/subkit/issues",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    query: { state: "all", since: "${scope.windows.data.previous_start}" },
    pagination: {
      strategy: "link",
      link_params: ["page", "after"],
      limit_param: "per_page",
      page_size: 100,
      max_pages: 20,
    },
    boundary: {
      variables: { "scope.windows.data.previous_start": { class: "timestamp" } },
      max_body_bytes: 0,
      max_calls: 20,
    },
    ...over,
  });

test("a link-paginated read reviews its sorted link and page-size parameters", () => {
  const { boundary, refusal } = compileRequestBoundary(linked(), "https://api.github.com");
  expect(refusal).toBeUndefined();
  expect(boundary?.pagination).toEqual({ params: ["after", "page", "per_page"], max_requests: 20 });
  const url = (extra: string) =>
    `https://api.github.com/repos/MikeBild/subkit/issues?state=all&since=2026-10-15T00:00:00Z&per_page=100${extra}`;
  for (const extra of ["", "&page=2", "&after=Y3Vyc29y&page=3", "&after=Y3Vyc29y"]) {
    expect(
      requestBoundaryViolation(boundary!, {
        method: "GET",
        url: url(extra),
        headers: {},
        body: null,
      }),
    ).toBeNull();
  }
});

test("a link parameter that is also an authored query key is refused", () => {
  for (const query of [{ page: "1" }, { per_page: "100" }, { after: "x" }]) {
    expect(
      compileRequestBoundary(
        linked({ query, boundary: { variables: {}, max_body_bytes: 0, max_calls: 20 } }),
        "https://api.github.com",
      ).refusal,
    ).toBe("pagination_param_conflict");
  }
});

test("a page-number read with page in its own query is refused", () => {
  expect(
    compileRequestBoundary(
      step({
        method: "GET",
        path: "/repos/a/b/commits",
        query: { page: "1" },
        pagination: {
          strategy: "page",
          page_param: "page",
          limit_param: "per_page",
          page_size: 100,
          max_pages: 10,
        },
        boundary: { variables: {}, max_body_bytes: 0, max_calls: 10 },
      }),
      "https://api.github.com",
    ).refusal,
  ).toBe("pagination_param_conflict");
});

test("timestamp_range admits a lower-bounded ISO timestamp only", () => {
  expect(VALUE_CLASSES.timestamp_range.test(">=2026-10-08T00:00:00.000Z")).toBe(true);
  expect(VALUE_CLASSES.timestamp_range.test(">=2026-10-08T00:00:00Z")).toBe(true);
  for (const value of [
    ">=x",
    "a..b",
    "2026-10-08T00:00:00Z",
    ">=2026-10-08",
    "<=2026-10-08T00:00:00Z",
  ])
    expect(VALUE_CLASSES.timestamp_range.test(value)).toBe(false);
  const { boundary, refusal } = compileRequestBoundary(
    step({
      method: "GET",
      path: "/repos/a/b/actions/runs",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      query: { created: "${scope.windows.data.actions_created}" },
      pagination: {
        strategy: "link",
        link_params: ["page"],
        limit_param: "per_page",
        page_size: 100,
        items_path: "workflow_runs",
        max_pages: 10,
      },
      boundary: {
        variables: { "scope.windows.data.actions_created": { class: "timestamp_range" } },
        max_body_bytes: 0,
        max_calls: 10,
      },
    }),
    "https://api.github.com",
  );
  expect(refusal).toBeUndefined();
  const at = (created: string) => ({
    method: "GET",
    url: `https://api.github.com/repos/a/b/actions/runs?created=${encodeURIComponent(created)}&per_page=100`,
    headers: {},
    body: null,
  });
  expect(requestBoundaryViolation(boundary!, at(">=2026-10-08T00:00:00.000Z"))).toBeNull();
  expect(requestBoundaryViolation(boundary!, at("2026-01-01..2026-12-31"))).not.toBeNull();
});

test("existing paging definitions and their reviewed boundaries keep their digests", () => {
  const pinned = {
    page: [
      {
        strategy: "page",
        page_size: 100,
        limit_param: "per_page",
        max_pages: 10,
      },
      "4ae4092173acc57dfce4141f1fe23b0ac80d12215b2bc682b2761a55a3f26576",
      "3234dd0eb87430d0207b2f6ba20280c7c9684e17feecb49ccd49b129d9b24b13",
    ],
  } as const;
  for (const [pagination, definitionDigest, boundaryDigest] of Object.values(pinned)) {
    const definition = WorkflowDefSchema.parse({
      name: "paged commits",
      steps: [
        {
          id: "commits",
          kind: "request",
          connector_id: "00000000-0000-4000-8000-000000000004",
          method: "GET",
          path: "/repos/o/r/commits",
          query: { sha: "main" },
          pagination,
          boundary: { variables: {}, max_body_bytes: 0, max_calls: 10 },
        },
      ],
    });
    expect(workflowJsonDigest(definition)).toBe(definitionDigest);
    const step = definition.steps[0];
    if (step?.kind !== "request") throw new Error("request step expected");
    expect(workflowJsonDigest(compileRequestBoundary(step, "https://api.github.com"))).toBe(
      boundaryDigest,
    );
  }
});
