import { expect, test } from "bun:test";
import { resolveUrl } from "../connectors/drivers/resolve-url.ts";
import { canonicalWorkflowJson, workflowJsonDigest } from "./canonical-json.ts";
import {
  assertRequestBoundary,
  compileRequestBoundary,
  describeRequestBoundaryViolation,
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
import { RequestStepSchema, WorkflowDefSchema } from "./types.ts";

const { release, stats } = requestBoundaryFixtures();

const ENCODED_SITE = "https%3A%2F%2Fexample.com%2F";

const searchQuery = step({
  method: "POST",
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
    "the reviewed query parameter `to` is missing",
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
      "(scope) => scope.plan.data.items.map((i) => ({ title: `Report ${scope.window.data.start}` }))",
    data_selector: "(out) => ({ id: `${out.id}` })",
    boundary: { ...release.boundary, max_calls: 20 },
  });
  expect(compileRequestBoundary(iterated, BASE).refusal).toBeUndefined();
  expect(
    compileRequestBoundary(step({ ...release, idempotency_key: "${input.site}" }), BASE).refusal,
  ).toBe("runtime_value_outside_path_and_body");
});

const paged = step({
  method: "GET",
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
  const forged = { ...boundary!, segments: [...(boundary!.segments ?? []), "tail"] };
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
