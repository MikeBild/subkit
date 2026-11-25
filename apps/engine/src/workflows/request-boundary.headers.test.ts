import { describe, expect, test } from "bun:test";
import { workflowJsonDigest } from "./canonical-json.ts";
import {
  compileRequestBoundary,
  describeRequestBoundaryViolation,
  type RequestBoundary,
  RequestBoundaryScopeSchema,
  requestBoundaryViolation,
} from "./request-boundary.ts";
import { RequestHeaderBoundsSchema, reviewedHeaderViolation } from "./request-boundary-headers.ts";
import {
  pathValueAllowed,
  ruleLabel,
  valueAllowed,
  variablesError,
  wholeValueExpression,
} from "./request-value-rules.ts";
import { type RequestStep, RequestStepSchema } from "./types.ts";

const BASE = "https://api.example.test";
const IDENTIFIER = { class: "identifier" } as const;

const step = (extra: Record<string, unknown> = {}, boundary: Record<string, unknown> = {}) =>
  RequestStepSchema.parse({
    id: "create",
    kind: "request",
    method: "POST",
    connector_id: "00000000-0000-4000-8000-000000000001",
    path: "/work",
    headers: { "Idempotency-Key": "${input.body.workId}" },
    body: { title: "${input.body.title}" },
    ...extra,
    boundary: {
      variables: {},
      headers: { "Idempotency-Key": IDENTIFIER },
      max_body_bytes: 1024,
      max_calls: 1,
      ...boundary,
    },
  }) as RequestStep;

const compile = (extra: Record<string, unknown> = {}, boundary: Record<string, unknown> = {}) =>
  compileRequestBoundary(step(extra, boundary), BASE);

describe("compiling boundary.headers", () => {
  const cases: Array<{
    name: string;
    extra?: Record<string, unknown>;
    boundary?: Record<string, unknown>;
    refusal?: string;
    headers?: Record<string, unknown>;
  }> = [
    {
      name: "a whole placeholder under a class rule",
      headers: { "Idempotency-Key": { var: "input.body.workId", rule: IDENTIFIER } },
    },
    {
      name: "a whole placeholder under an enum rule",
      extra: { headers: { "X-Tenant": "${input.tenant}" } },
      boundary: { headers: { "X-Tenant": { enum: ["acme", "globex"] } } },
      headers: { "X-Tenant": { var: "input.tenant", rule: { enum: ["acme", "globex"] } } },
    },
    {
      name: "a name matched regardless of case keeps the reviewed literal",
      extra: { headers: { "idempotency-key": "${scope.plan.data.key}" } },
      headers: { "Idempotency-Key": { var: "scope.plan.data.key", rule: IDENTIFIER } },
    },
    {
      name: "the step idempotency_key is bounded through its header",
      extra: { headers: undefined, idempotency_key: "${input.body.workId}" },
      headers: { "Idempotency-Key": { var: "input.body.workId", rule: IDENTIFIER } },
    },
    {
      name: "literal and vault headers need no entry",
      extra: {
        headers: {
          "Idempotency-Key": "${input.body.workId}",
          Authorization: "Bearer ${secret.crm-token}",
          Accept: "application/json",
        },
      },
      headers: { "Idempotency-Key": { var: "input.body.workId", rule: IDENTIFIER } },
    },
    {
      name: "a placeholder header without an entry stays refused",
      extra: { headers: { "X-Trace": "${input.trace}" } },
      boundary: { headers: undefined },
      refusal: "runtime_header",
    },
    {
      name: "a placeholder in the header name is refused",
      extra: { headers: { "X-${input.name}": "fixed" } },
      boundary: { headers: undefined },
      refusal: "runtime_header",
    },
    {
      name: "text around the placeholder is refused",
      extra: { headers: { "Idempotency-Key": "work-${input.body.workId}" } },
      refusal: "runtime_header",
    },
    {
      name: "a caller expression is refused",
      extra: { headers: { "Idempotency-Key": "${caller.subject}" } },
      refusal: "runtime_header",
    },
    {
      name: "an entry for a literal header is a mismatch",
      extra: { headers: { "Idempotency-Key": "fixed-key" } },
      refusal: "header_boundary_mismatch",
    },
    {
      name: "an entry for a header that is not sent is a mismatch",
      boundary: { headers: { "Idempotency-Key": IDENTIFIER, "X-Tenant": IDENTIFIER } },
      refusal: "header_boundary_mismatch",
    },
    {
      name: "one entry cannot bound the same header sent twice",
      extra: {
        headers: { "Idempotency-Key": "${input.body.workId}", "idempotency-key": "${input.b}" },
      },
      refusal: "header_boundary_mismatch",
    },
    {
      name: "a variables-bound Idempotency-Key next to a literal twin stays refused",
      extra: { headers: { "Idempotency-Key": "${input.key}", "idempotency-key": "fixed" } },
      boundary: { headers: undefined, variables: { "input.key": IDENTIFIER } },
      refusal: "runtime_header",
    },
    {
      name: "the header expression is not a variables entry",
      boundary: { variables: { "input.body.workId": IDENTIFIER } },
      refusal: "variables_mismatch",
    },
  ];
  for (const entry of cases)
    test(entry.name, () => {
      const compiled = compile(entry.extra, entry.boundary);
      expect(compiled.refusal).toBe(entry.refusal as never);
      expect(compiled.boundary?.headers).toEqual(entry.headers as never);
    });

  test("a boundary without headers compiles exactly as before", () => {
    const compiled = compile(
      { headers: { "Idempotency-Key": "${input.key}" } },
      { headers: undefined, variables: { "input.key": IDENTIFIER } },
    );
    expect(compiled.boundary?.idempotency_key).toEqual({ var: "input.key" });
    expect(compiled.boundary && "headers" in compiled.boundary).toBe(false);
  });

  test("a bounded header on an allowed-host destination is reviewed", () => {
    const compiled = compileRequestBoundary(
      step(
        { connector_id: undefined, path: undefined, url: "${input.url}" },
        { allowed_hosts: ["api.example.test"] },
      ),
      null,
    );
    expect(compiled.boundary?.headers).toEqual({
      "Idempotency-Key": { var: "input.body.workId", rule: IDENTIFIER },
    });
  });

  test("changing a header rule or name changes the reviewed boundary digest", () => {
    const digest = (extra: Record<string, unknown>, boundary: Record<string, unknown>) =>
      workflowJsonDigest(compile(extra, boundary).boundary);
    const reviewed = digest({}, {});
    expect(digest({}, { headers: { "Idempotency-Key": { enum: ["work-1"] } } })).not.toBe(reviewed);
    expect(
      digest(
        { headers: { "X-Request-Key": "${input.body.workId}" } },
        { headers: { "X-Request-Key": IDENTIFIER } },
      ),
    ).not.toBe(reviewed);
    expect(digest({}, {})).toBe(reviewed);
  });
});

describe("boundary.headers schema", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["class rule", { "Idempotency-Key": IDENTIFIER }, true],
    ["enum rule", { "X-Mode": { enum: ["a", "b:c"] } }, true],
    ["placeholder name", { "${input.name}": IDENTIFIER }, false],
    ["names differing only by case", { "X-A": IDENTIFIER, "x-a": IDENTIFIER }, false],
    ["path class", { "X-A": { class: "path" } }, false],
    ["enum with a control character", { "X-A": { enum: ["%00"] } }, false],
    ["enum with a dot segment", { "X-A": { enum: ["%2e%2e"] } }, false],
    ["enum with a broken escape", { "X-A": { enum: ["%E0%A4"] } }, false],
    ["caller_bound", { "X-A": { caller_bound: true } }, false],
    [
      "more than twenty names",
      Object.fromEntries([...Array(21).keys()].map((i) => [`X-${i}`, IDENTIFIER])),
      false,
    ],
  ];
  for (const [name, value, ok] of cases)
    test(name, () => {
      expect(RequestHeaderBoundsSchema.safeParse(value).success).toBe(ok);
      expect(
        RequestBoundaryScopeSchema.safeParse({
          variables: {},
          headers: value,
          max_body_bytes: 0,
          max_calls: 1,
        }).success,
      ).toBe(ok);
    });
});

describe("runtime check of reviewed headers", () => {
  const reviewed = compile().boundary as RequestBoundary;
  const request = (headers: Record<string, string>) => ({
    method: "POST",
    url: `${BASE}/work`,
    headers,
    body: { title: "x" },
  });
  const cases: Array<[string, Record<string, string>, string | null]> = [
    ["a value inside the rule", { "Idempotency-Key": "work-42" }, null],
    ["a name in another case", { "idempotency-key": "work-42" }, null],
    ["a value outside the rule", { "Idempotency-Key": "work 42!" }, "Idempotency-Key"],
    ["a missing header", { Accept: "application/json" }, "Idempotency-Key"],
    ["a repeated header", { "Idempotency-Key": "a", "idempotency-key": "b" }, "Idempotency-Key"],
  ];
  for (const [name, headers, violation] of cases)
    test(name, () => {
      expect(reviewedHeaderViolation(reviewed.headers, headers)).toBe(violation);
      const result = requestBoundaryViolation(reviewed, request(headers));
      expect(result).toEqual(violation === null ? null : { kind: "header", name: violation });
    });

  test("the violation names the header", () => {
    expect(describeRequestBoundaryViolation({ kind: "header", name: "Idempotency-Key" })).toBe(
      "the header `Idempotency-Key` is missing, repeated or outside its reviewed value rule",
    );
  });

  test("a boundary without reviewed headers checks nothing", () => {
    expect(reviewedHeaderViolation(undefined, {})).toBeNull();
  });
});

describe("shared value rules", () => {
  const cases: Array<[string, Parameters<typeof valueAllowed>[0], string, boolean]> = [
    ["no rule", undefined, "a", false],
    ["enum hit", { enum: ["a"] }, "a", true],
    ["enum miss", { enum: ["a"] }, "b", false],
    ["caller uuid", { caller_bound: true }, "00000000-0000-4000-8000-000000000000", true],
    ["path class never as a single value", { class: "path" }, "a", false],
    ["identifier", IDENTIFIER, "work-42", true],
    ["identifier refuses a space", IDENTIFIER, "work 42", false],
  ];
  for (const [name, rule, value, ok] of cases)
    test(name, () => expect(valueAllowed(rule, value)).toBe(ok));

  test("only an invalid variables key gets the key explanation", () => {
    expect(variablesError({ code: "invalid_key" })).toContain("placeholder expression");
    expect(variablesError({ code: "invalid_type" })).toBeUndefined();
  });

  test("labels every rule kind", () => {
    expect(ruleLabel(undefined)).toBe("no rule");
    expect(ruleLabel({ enum: ["a", "b"] })).toBe("enum of 2 value(s)");
    expect(ruleLabel({ caller_bound: true })).toBe("the authenticated caller");
    expect(ruleLabel(IDENTIFIER)).toBe("class identifier");
  });

  test("a whole value expression excludes caller and partial placeholders", () => {
    expect(wholeValueExpression("${input.a}")).toBe("input.a");
    expect(wholeValueExpression("${caller.subject}")).toBeNull();
    expect(wholeValueExpression("x-${input.a}")).toBeNull();
    expect(wholeValueExpression(1)).toBeNull();
  });

  test("path values refuse traversal and bad escapes", () => {
    expect(pathValueAllowed("docs/guide/")).toBe(true);
    expect(pathValueAllowed("a/../b")).toBe(false);
    expect(pathValueAllowed("a/%2e%2e")).toBe(false);
    expect(pathValueAllowed("%E0%A4")).toBe(false);
    expect(pathValueAllowed("//a")).toBe(false);
    expect(pathValueAllowed("a".repeat(1025))).toBe(false);
    expect(pathValueAllowed("a b")).toBe(false);
  });
});
