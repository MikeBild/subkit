import { describe, expect, test } from "bun:test";
import { compileRequestBoundary, requestBoundaryViolation } from "./request-boundary.ts";
import { BASE, step } from "./request-boundary-fixtures.ts";

const SITE = { "input.site": { enum: ["blog"] } };

function contacts(extra: Record<string, unknown>) {
  return step({
    method: "GET",
    path: "/sites/${input.site}/contacts",
    boundary: { variables: SITE, max_body_bytes: 0, max_calls: 1 },
    ...extra,
  });
}

const url = (query: string) => `https://api.example.test/v2/sites/blog/contacts${query}`;

describe("a vault handle in the query", () => {
  test("is a reviewed key whose value the approval does not pin", () => {
    const { boundary, refusal } = compileRequestBoundary(
      contacts({ query: { account: "${secret.crm-token}", page: "1" } }),
      BASE,
    );
    expect(refusal).toBeUndefined();
    expect(boundary?.query).toEqual({ fixed: { page: "1" }, variable: [], vault: ["account"] });
    expect(
      requestBoundaryViolation(boundary!, {
        method: "GET",
        url: url("?account=x&page=1"),
        headers: {},
        body: null,
      }),
    ).toBeNull();
    expect(
      requestBoundaryViolation(boundary!, {
        method: "GET",
        url: url("?account=rotated&page=1"),
        headers: {},
        body: null,
      }),
    ).toBeNull();
  });

  test("must be sent, and nothing unreviewed may join it", () => {
    const { boundary } = compileRequestBoundary(
      contacts({ query: { account: "${secret.crm-token}" } }),
      BASE,
    );
    expect(
      requestBoundaryViolation(boundary!, { method: "GET", url: url(""), headers: {}, body: null }),
    ).toEqual({
      kind: "query",
      detail: { reason: "missing_key", key: "account" },
    });
    expect(
      requestBoundaryViolation(boundary!, {
        method: "GET",
        url: url("?account=x&extra=1"),
        headers: {},
        body: null,
      }),
    ).toEqual({ kind: "query", detail: { reason: "unexpected_key", key: "extra" } });
  });

  test("keeps a boundary without handles byte-identical", () => {
    const { boundary } = compileRequestBoundary(contacts({ query: { page: "1" } }), BASE);
    expect(boundary?.query).toEqual({ fixed: { page: "1" }, variable: [] });
    expect(JSON.stringify(boundary?.query)).not.toContain("vault");
  });

  test("may carry fixed text around the handle, as in a header", () => {
    const { boundary } = compileRequestBoundary(
      contacts({ query: { account: "id-${secret.crm-token}" } }),
      BASE,
    );
    expect(boundary?.query.vault).toEqual(["account"]);
  });

  test("still refuses a handle mixed with other placeholders or in a key", () => {
    expect(
      compileRequestBoundary(
        contacts({ query: { account: "${secret.crm-token}${input.site}" } }),
        BASE,
      ).refusal,
    ).toBe("query_placeholder_unsupported");
    expect(
      compileRequestBoundary(contacts({ query: { "${secret.crm-token}": "x" } }), BASE).refusal,
    ).toBe("query_placeholder_unsupported");
  });

  test("never shares its key with the connector's own query or paging", () => {
    expect(
      compileRequestBoundary(contacts({ query: { account: "${secret.crm-token}" } }), BASE, {
        fixed: {},
        credential: ["account"],
      }).refusal,
    ).toBe("connector_query_conflict");
    expect(
      compileRequestBoundary(
        contacts({
          query: { cursor: "${secret.crm-token}" },
          pagination: {
            strategy: "cursor",
            cursor_request_param: "cursor",
            cursor_response_path: "$.next",
            max_pages: 3,
          },
        }),
        BASE,
      ).refusal,
    ).toBe("pagination_param_conflict");
  });
});

describe("a vault handle in the body", () => {
  test("is approvable like any other body value", () => {
    const { boundary, refusal } = compileRequestBoundary(
      contacts({
        method: "POST",
        body: { note: "${secret.crm-token}", login: { user: "${secret.erp.username}" } },
        boundary: { variables: SITE, max_body_bytes: 500, max_calls: 1 },
      }),
      BASE,
    );
    expect(refusal).toBeUndefined();
    expect(boundary?.max_body_bytes).toBe(500);
  });
});
