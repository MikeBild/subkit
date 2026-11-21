import { expect, test } from "bun:test";
import { workflowJsonDigest } from "./canonical-json.ts";
import {
  compileRequestBoundary,
  describeRequestBoundaryViolation,
  pagedBodyGuard,
  RequestBoundarySchema,
  requestBoundaryViolation,
} from "./request-boundary.ts";
import { BASE, step } from "./request-boundary-fixtures.ts";

const cursor = (over: Record<string, unknown> = {}) => ({
  strategy: "cursor",
  cursor_request_param: "cursor",
  cursor_response_path: "$.next",
  limit_param: "limit",
  page_size: 50,
  max_pages: 4,
  parameter_location: "body",
  ...over,
});

const search = (over: Record<string, unknown> = {}) =>
  step({
    method: "POST",
    path: "/sites/${input.site}/search",
    body: { filter: { status: "open" }, since: "${scope.window.data.start}" },
    pagination: cursor(),
    boundary: {
      variables: { "input.site": { enum: ["blog"] } },
      max_body_bytes: 500,
      max_calls: 1,
    },
    ...over,
  });

const URL_OK = "https://api.example.test/v2/sites/blog/search";
const FIRST = { filter: { status: "open" }, since: "2026-11-01", limit: 50 };

function compiled(over: Record<string, unknown> = {}) {
  const { boundary, refusal } = compileRequestBoundary(search(over), BASE);
  if (!boundary) throw new Error(`boundary did not compile: ${refusal}`);
  return boundary;
}

function violation(body: unknown, url = URL_OK) {
  return requestBoundaryViolation(compiled(), {
    method: "POST",
    url,
    headers: {},
    body: body as never,
  });
}

test("a step that pages through the body compiles with its fields and its page ceiling", () => {
  expect(compiled().pagination).toEqual({
    params: ["cursor", "limit"],
    max_requests: 4,
    location: "body",
  });
  expect(compiled({ body: undefined }).pagination?.location).toBe("body");
  expect(
    compiled({
      pagination: {
        strategy: "offset",
        offset_param: "from",
        limit_param: "size",
        max_pages: 2,
        parameter_location: "body",
      },
    }).pagination,
  ).toEqual({ params: ["from", "size"], max_requests: 2, location: "body" });
  expect(
    compiled({
      pagination: {
        strategy: "page",
        page_param: "page",
        limit_param: "per_page",
        max_pages: 9,
        parameter_location: "body",
      },
    }).pagination,
  ).toEqual({ params: ["page", "per_page"], max_requests: 9, location: "body" });
});

test("paging through the query keeps the boundary it always had", () => {
  const viaQuery = compileRequestBoundary(
    search({ pagination: cursor({ parameter_location: "query" }) }),
    BASE,
  ).boundary;
  const unstated = compileRequestBoundary(
    search({ pagination: cursor({ parameter_location: undefined }) }),
    BASE,
  ).boundary;
  expect(viaQuery?.pagination).toEqual({ params: ["cursor", "limit"], max_requests: 4 });
  expect(workflowJsonDigest(viaQuery)).toBe(workflowJsonDigest(unstated));
  expect(workflowJsonDigest(viaQuery)).not.toBe(workflowJsonDigest(compiled()));
});

test("every unbounded variant of body paging is refused", () => {
  const refusal = (over: Record<string, unknown>) =>
    compileRequestBoundary(search(over), BASE).refusal;
  expect(refusal({ pagination: cursor({ max_pages: undefined }) })).toBe("pagination_unbounded");
  expect(refusal({ method: "GET", body: undefined })).toBe("pagination_body_unsupported");
  expect(refusal({ method: "HEAD", body: undefined })).toBe("pagination_body_unsupported");
  expect(refusal({ body: "cursor=1" })).toBe("pagination_body_unsupported");
  expect(refusal({ body: "${scope.build.data.body}" })).toBe("pagination_body_unsupported");
  expect(refusal({ body: [{ filter: "open" }] })).toBe("pagination_body_unsupported");
  expect(refusal({ body: 5 })).toBe("pagination_body_unsupported");
  expect(refusal({ body: { "${input.field}": "x" } })).toBe("pagination_body_unsupported");
  expect(refusal({ body: { cursor: "start" } })).toBe("pagination_param_conflict");
  expect(refusal({ body: { limit: "${input.limit}" } })).toBe("pagination_param_conflict");
  expect(
    refusal({
      body: undefined,
      multipart: [{ name: "note", value: "a" }],
    }),
  ).toBe("pagination_unsupported");
  expect(refusal({ pagination: cursor({ cursor_request_param: "" }) })).toBe(
    "pagination_unsupported",
  );
});

test("the manifest digest follows the paging fields, the ceiling and the location", () => {
  const reviewed = workflowJsonDigest(compiled());
  expect(workflowJsonDigest(compiled({ pagination: cursor({ max_pages: 5 }) }))).not.toBe(reviewed);
  expect(
    workflowJsonDigest(compiled({ pagination: cursor({ cursor_request_param: "after" }) })),
  ).not.toBe(reviewed);
  expect(workflowJsonDigest(compiled({ pagination: cursor({ limit_param: "size" }) }))).not.toBe(
    reviewed,
  );
  expect(workflowJsonDigest(compiled())).toBe(reviewed);
});

test("each page is admitted only as a JSON object whose paging fields are plain values", () => {
  expect(violation(FIRST)).toBeNull();
  expect(violation({ ...FIRST, cursor: "abc" })).toBeNull();
  expect(violation(JSON.stringify({ ...FIRST, cursor: "abc" }))).toBeNull();
  expect(violation({ limit: 50 })).toBeNull();
  expect(violation(null)).toEqual({ kind: "paged_body", detail: { reason: "not_an_object" } });
  expect(violation("cursor=abc")).toEqual({
    kind: "paged_body",
    detail: { reason: "not_an_object" },
  });
  expect(violation([FIRST])).toEqual({ kind: "paged_body", detail: { reason: "not_an_object" } });
  expect(violation({ ...FIRST, cursor: { $ne: null } })).toEqual({
    kind: "paged_body",
    detail: { reason: "paging_value", field: "cursor" },
  });
  expect(violation({ ...FIRST, limit: [50] })).toEqual({
    kind: "paged_body",
    detail: { reason: "paging_value", field: "limit" },
  });
  expect(violation({ ...FIRST, cursor: null })).toEqual({
    kind: "paged_body",
    detail: { reason: "paging_value", field: "cursor" },
  });
  expect(violation({ ...FIRST, note: "x".repeat(600) })).toMatchObject({ kind: "body_size" });
});

test("a body paging field in the query is not part of the reviewed request", () => {
  expect(violation(FIRST, `${URL_OK}?cursor=abc`)).toEqual({
    kind: "query",
    detail: { reason: "unexpected_key", key: "cursor" },
  });
  expect(violation(FIRST, `${URL_OK}?limit=50`)).toEqual({
    kind: "query",
    detail: { reason: "unexpected_key", key: "limit" },
  });
});

test("later pages may move the paging fields and nothing else", () => {
  const guard = pagedBodyGuard(compiled());
  if (!guard) throw new Error("missing guard");
  expect(guard(FIRST)).toBeNull();
  expect(guard(FIRST)).toBeNull();
  expect(guard({ ...FIRST, cursor: "p2" })).toBeNull();
  expect(
    guard(
      JSON.stringify({ since: "2026-11-01", cursor: "p3", limit: 50, filter: { status: "open" } }),
    ),
  ).toBeNull();
  expect(guard({ ...FIRST, cursor: "p4", since: "2020-01-01" })).toEqual({
    reason: "changed_between_pages",
  });
  expect(guard({ ...FIRST, cursor: "p4", filter: { status: "all" } })).toEqual({
    reason: "changed_between_pages",
  });
  expect(guard({ ...FIRST, cursor: "p4", extra: true })).toEqual({
    reason: "changed_between_pages",
  });
  const { since: _since, ...withoutSince } = FIRST;
  expect(guard({ ...withoutSince, cursor: "p4" })).toEqual({ reason: "changed_between_pages" });
  expect(guard({ ...FIRST, cursor: ["p4"] })).toEqual({ reason: "paging_value", field: "cursor" });
  expect(guard("not json")).toEqual({ reason: "not_an_object" });
  expect(guard({ ...FIRST, cursor: "p4" })).toBeNull();
});

test("the guard compares pages and leaves the page count to the paging loop", () => {
  const guard = pagedBodyGuard(compiled({ pagination: cursor({ max_pages: 2 }) }));
  if (!guard) throw new Error("missing guard");
  for (const page of ["p1", "p2", "p3", "p4", "p5"])
    expect(guard({ ...FIRST, cursor: page })).toBeNull();
  expect(guard({ ...FIRST, cursor: "p6", since: "2020-01-01" })).toEqual({
    reason: "changed_between_pages",
  });
});

test("only a boundary that pages through the body has a page guard", () => {
  expect(
    pagedBodyGuard(
      compileRequestBoundary(search({ pagination: cursor({ parameter_location: "query" }) }), BASE)
        .boundary!,
    ),
  ).toBeNull();
  expect(
    pagedBodyGuard(compileRequestBoundary(search({ pagination: undefined }), BASE).boundary!),
  ).toBeNull();
});

test("every body paging refusal says what is wrong without quoting the body", () => {
  for (const body of [null, { ...FIRST, cursor: { secret: "s3cr3t" } }]) {
    const found = violation(body);
    expect(found).not.toBeNull();
    const text = describeRequestBoundaryViolation(found!);
    expect(text.length).toBeGreaterThan(20);
    expect(text).not.toContain("s3cr3t");
  }
});

test("a stored boundary that pages a bodiless method through the body is not trusted", () => {
  const boundary = compiled();
  expect(RequestBoundarySchema.safeParse(boundary).success).toBe(true);
  expect(RequestBoundarySchema.safeParse({ ...boundary, method: "GET" }).success).toBe(false);
  expect(RequestBoundarySchema.safeParse({ ...boundary, body_encoding: "multipart" }).success).toBe(
    false,
  );
  expect(
    RequestBoundarySchema.safeParse({
      ...boundary,
      pagination: { ...boundary.pagination, location: "header" },
    }).success,
  ).toBe(false);
});
