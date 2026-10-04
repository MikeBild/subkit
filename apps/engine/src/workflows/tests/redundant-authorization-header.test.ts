// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` placeholder tokens are part of the tested grammar.
// Authoring-time check: a request step with `connector_id` must not
// also set an `Authorization` header. Pre-fix the LLM routinely
// authored both — driving the GitHub "Bad credentials" loop in
// session 1222158a where the explicit header
// `Bearer ${cred.github-api.token}` overrode the connector's
// auto-injected auth, the placeholder failed to expand, and the
// runtime sent a literal "Bearer ${cred.github-api.token}" string
// that GitHub rejected with HTTP 401. The probe (which does NOT use
// the workflow runtime substitution) succeeded with the same token,
// which made the failure mode confusing for the user. The validator
// now refuses the redundant header so the LLM gets a typed error
// before dry_run.

import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../validator.ts";

describe("validateWorkflowDef · redundant Authorization header", () => {
  test("rejects a request step with both connector_id and an Authorization header", () => {
    const result = validateWorkflowDef({
      name: "t",
      steps: [
        {
          id: "fetch_repos",
          kind: "request",
          method: "GET",
          path: "/user/repos",
          connector_id: "584ef58a-c4dd-454c-bfb8-7dd0925ccb1e",
          headers: {
            Authorization: "Bearer xyz",
            Accept: "application/vnd.github.v3+json",
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    const authError = result.errors.find(
      (e) => e.path.startsWith("steps.fetch_repos.headers.") && /Authorization/i.test(e.path),
    );
    expect(authError).toBeDefined();
    expect(authError?.message).toMatch(/connector injects auth/i);
  });

  test("matches Authorization case-insensitively (lowercase variant)", () => {
    const result = validateWorkflowDef({
      name: "t",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          path: "/x",
          connector_id: "a1b2c3d4-1111-4222-8333-444455556666",
          headers: { authorization: "Bearer y" },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /headers\.authorization/.test(e.path))).toBe(true);
  });

  test("rejects the placeholder form of the Authorization header", () => {
    const result = validateWorkflowDef({
      name: "t",
      steps: [
        {
          id: "fetch_repos",
          kind: "request",
          method: "GET",
          path: "/user/repos",
          connector_id: "a1b2c3d4-2222-4222-8333-444455556666",
          headers: {
            Authorization: "Bearer ${cred.github-api.token}",
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.path === "steps.fetch_repos.headers.Authorization" &&
          /connector injects auth/i.test(e.message),
      ),
    ).toBe(true);
  });

  test("accepts a request step with connector_id and non-auth headers", () => {
    const result = validateWorkflowDef({
      name: "t",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          path: "/x",
          connector_id: "a1b2c3d4-3333-4222-8333-444455556666",
          headers: { Accept: "application/json", "X-Trace": "abc" },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts an Authorization header on a request step that has NO connector_id", () => {
    const result = validateWorkflowDef({
      name: "t",
      steps: [
        {
          id: "external",
          kind: "request",
          method: "GET",
          url: "https://example.com/api",
          headers: { Authorization: "Bearer ${env.OUTSIDE_TOKEN}" },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  const reservedHeaders = [
    ["Cookie", "session=abc"],
    ["cookie", "session=abc"],
    ["COOKIE", "session=abc"],
    ["Proxy-Authorization", "Bearer proxytoken"],
    ["proxy-authorization", "Bearer proxytoken"],
    ["PROXY-AUTHORIZATION", "Bearer proxytoken"],
  ] as const;

  for (const [headerName, headerValue] of reservedHeaders) {
    test(`rejects connector request header ${headerName}`, () => {
      const result = validateWorkflowDef({
        name: "t",
        steps: [
          {
            id: "fetch",
            kind: "request",
            method: "GET",
            path: "/me",
            connector_id: "a1b2c3d4-1111-4222-8333-444455556666",
            headers: { [headerName]: headerValue },
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.path.endsWith(`.headers.${headerName}`))).toBe(true);
    });
  }

  test("accepts step-level Authorization on a connector_id whose auth_type is none", () => {
    const noneAuthId = "a1b2c3d4-4444-4222-8333-444455556666";
    const result = validateWorkflowDef(
      {
        name: "t",
        steps: [
          {
            id: "fetch",
            kind: "request",
            method: "GET",
            path: "/me",
            connector_id: noneAuthId,
            headers: { Authorization: "Bearer ${scope.login.data.access_token}" },
          },
        ],
      },
      { noneAuthConnectorIds: new Set([noneAuthId]) },
    );
    expect(result.ok).toBe(true);
  });
});
