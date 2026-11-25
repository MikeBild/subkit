import { describe, expect, test } from "bun:test";
import {
  compileRequestBoundary,
  describeRequestBoundaryViolation,
  type RequestBoundary,
  requestBoundaryTarget,
  requestBoundaryViolation,
} from "./request-boundary.ts";
import { RequestStepSchema } from "./types.ts";

const HOSTS = ["docs.example.com", "xn--caf-dma.example"];

const runtimeStep = (extra: Record<string, unknown> = {}, boundary: Record<string, unknown> = {}) =>
  RequestStepSchema.parse({
    id: "fetch",
    kind: "request",
    method: "GET",
    url: "${input.url}",
    boundary: { variables: {}, max_body_bytes: 0, max_calls: 1, allowed_hosts: HOSTS, ...boundary },
    ...extra,
  });

const compiled = (step = runtimeStep()) => {
  const outcome = compileRequestBoundary(step, null);
  expect(outcome.refusal).toBeUndefined();
  return outcome.boundary as RequestBoundary;
};

const get = (url: string, method = "GET") => ({ method, url, headers: {}, body: null });

describe("a runtime url bounded by allowed hosts (#859)", () => {
  test("compiles into a boundary that names the variable and every allowed host", () => {
    const boundary = compiled(runtimeStep({}, { allowed_hosts: [...HOSTS].reverse() }));
    expect(boundary.destination).toEqual({ var: "input.url", hosts: HOSTS });
    expect(boundary.origin).toBeUndefined();
    expect(boundary.segments).toBeUndefined();
    expect(requestBoundaryTarget(boundary)).toBe(
      "{input.url} on https://docs.example.com, https://xn--caf-dma.example",
    );
  });

  test("a for_each item url compiles the same way", () => {
    const boundary = compiled(
      runtimeStep(
        { url: "${item.page_url}", for_each: "(sourceData) => sourceData.urls.data" },
        { max_calls: 1000 },
      ),
    );
    expect(boundary.destination?.var).toBe("item.page_url");
    expect(boundary.max_calls).toBe(1000);
  });

  test("without an allowed host list a runtime url stays refused as before", () => {
    const step = RequestStepSchema.parse({
      id: "fetch",
      kind: "request",
      method: "GET",
      url: "${input.target}",
    });
    expect(compileRequestBoundary(step, null).refusal).toBe("no_boundary");
    const bounded = RequestStepSchema.parse({
      id: "fetch",
      kind: "request",
      method: "GET",
      url: "${input.target}",
      boundary: { variables: {}, max_body_bytes: 0, max_calls: 1 },
    });
    expect(compileRequestBoundary(bounded, null).refusal).toBeDefined();
  });

  test("an allowed host list that was never pinned is refused", () => {
    const step = runtimeStep({}, { allowed_hosts: "${input.allowed_hosts}" });
    expect(compileRequestBoundary(step, null).refusal).toBe("allowed_hosts_unpinned");
  });

  test("the step schema refuses a host list with wildcards, ports or schemes", () => {
    for (const allowed_hosts of [
      ["*.example.com"],
      ["example.com:443"],
      ["https://example.com"],
      [],
    ])
      expect(() => runtimeStep({}, { allowed_hosts })).toThrow();
  });

  test("the destination must be the whole url and the only runtime part of the target", () => {
    const refusal = (extra: Record<string, unknown>, boundary: Record<string, unknown> = {}) =>
      compileRequestBoundary(runtimeStep(extra, boundary), null).refusal;
    expect(refusal({ url: "https://${input.host}/page" })).toBe("runtime_destination_unsupported");
    expect(refusal({ url: "${input.url}/page" })).toBe("runtime_destination_unsupported");
    expect(refusal({ url: "${caller.subject}" })).toBe("runtime_destination_unsupported");
    expect(refusal({ query: { q: "x" } })).toBe("runtime_destination_unsupported");
    expect(
      refusal({
        pagination: { strategy: "page", page_param: "p", limit_param: "l", max_pages: 2 },
      }),
    ).toBe("runtime_destination_unsupported");
    expect(refusal({ method: "DELETE" }, { destructive: true })).toBe("delete_requires_enum");
    expect(refusal({}, { variables: { "input.url": { class: "path" } } })).toBe(
      "variables_mismatch",
    );
    expect(compileRequestBoundary(runtimeStep(), "https://api.example.test").refusal).toBe(
      "runtime_destination_unsupported",
    );
  });

  test("a runtime url on an allowed host passes the reviewed boundary", () => {
    const boundary = compiled();
    for (const url of [
      "https://docs.example.com/guide/intro?lang=en",
      "https://DOCS.example.com/",
      "https://docs.example.com:443/a",
      "https://café.example/menu",
    ])
      expect(requestBoundaryViolation(boundary, get(url))).toBeNull();
  });

  test("every other destination fails closed and says which rule it broke", () => {
    const boundary = compiled();
    const cases: Array<[string, string]> = [
      ["http://docs.example.com/", "scheme"],
      ["https://docs.example.com@evil.example.net/", "userinfo"],
      ["https://user:pw@docs.example.com/", "userinfo"],
      ["https://docs.example.com:8443/", "port"],
      ["https://docs.example.com./", "host"],
      ["https://evil.docs.example.com/", "host"],
      ["https://docs.example.com.evil.example.net/", "host"],
      ["https://cafe.example/", "host"],
      ["ftp://docs.example.com/", "scheme"],
    ];
    for (const [url, issue] of cases) {
      const violation = requestBoundaryViolation(boundary, get(url));
      expect(violation).toMatchObject({ kind: "destination", issue });
      expect(describeRequestBoundaryViolation(violation!)).toContain("docs.example.com");
    }
    expect(
      requestBoundaryViolation(boundary, get("https://docs.example.com/", "POST")),
    ).toMatchObject({
      kind: "method",
    });
  });
});
