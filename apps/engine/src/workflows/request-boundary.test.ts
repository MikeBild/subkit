import { expect, test } from "bun:test";
import { resolveUrl } from "../connectors/drivers/resolve-url.ts";
import {
  assertRequestBoundary,
  compileRequestBoundary,
  pathValueAllowed,
  RequestBoundarySchema,
  requestBoundaryTarget,
  requestBoundaryViolation,
  VALUE_CLASSES,
} from "./request-boundary.ts";
import {
  BASE,
  GOOD_QUERY,
  ID,
  requestBoundaryFixtures,
  statsUrl,
  step,
} from "./request-boundary-fixtures.ts";
import { RequestStepSchema } from "./types.ts";

const { release, stats } = requestBoundaryFixtures();

test("the reviewed target keeps the base path and names the variable", () => {
  const { boundary } = compileRequestBoundary(release, BASE);
  expect(boundary?.origin).toBe("https://api.example.test");
  expect(boundary?.segments).toEqual(["", "v2", "sites", { var: "input.site" }, "releases"]);
  expect(requestBoundaryTarget(boundary!)).toBe(
    "https://api.example.test/v2/sites/{input.site}/releases",
  );
});

test("review and dispatch agree, including when the author repeats the base prefix", () => {
  for (const path of ["/sites/${input.site}/releases", "/v2/sites/${input.site}/releases"]) {
    const { boundary } = compileRequestBoundary(step({ ...release, path }), BASE);
    expect(boundary).toBeDefined();
    for (const site of ["company-cockpit", "blog"]) {
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
      step({ protocol: "s3", method: "GET", s3: { key: "a" }, boundary: release.boundary }),
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
      body: undefined,
      multipart: [{ name: "note", value: "a" }],
      pagination: {
        strategy: "cursor",
        cursor_request_param: "cursor",
        cursor_response_path: "$.next",
        max_pages: 5,
        parameter_location: "body",
      },
    }),
  ).toBe("pagination_unsupported");
  expect(reason({ query: { since: "from-${input.since}" } })).toBe("query_placeholder_unsupported");
  expect(reason({ query: { since: "${input.since}" } })).toBe("variables_mismatch");
  expect(reason({ headers: { "x-tenant": "${input.tenant}" } })).toBe("runtime_header");
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
      path: "/spaces/${item.slug}/proposals",
      query: { status: "pending" },
      boundary: {
        variables: { "item.slug": { enum: ["handbook", "blog-de"] } },
        max_body_bytes: 0,
        max_calls: 6,
      },
    }),
    BASE,
  );
  expect(boundary?.query.fixed).toEqual({ status: "pending" });
  const ok = {
    method: "GET",
    url: "https://api.example.test/v2/spaces/handbook/proposals?status=pending",
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

test("the class patterns are pinned: a live approval must never change meaning", () => {
  expect(Object.fromEntries(Object.entries(VALUE_CLASSES).map(([k, v]) => [k, v.source]))).toEqual({
    identifier: "^[A-Za-z0-9_-]{1,200}$",
    long_identifier: "^[A-Za-z0-9_-]{1,1024}$",
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
