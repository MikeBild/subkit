import { describe, expect, test } from "bun:test";
import { describeExecutionCaller } from "./caller-summary.ts";

const RUN = "11111111-1111-4111-8111-111111111111";
const ROOT = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";

describe("who started a run", () => {
  test("a person signed in through the browser is named with how SubKit checked them", () => {
    const caller = describeExecutionCaller({
      id: RUN,
      request_source: "cockpit",
      authority_root_execution_id: null,
      caller_context: {
        tenantId: "44444444-4444-4444-8444-444444444444",
        principalId: PERSON,
        principalKind: "user",
        provider: "oidc",
        productId: null,
      },
      authorization_context: {
        source: { kind: "browser_session", session_id: "55555555-5555-4555-8555-555555555555" },
      },
    });
    expect(caller).toEqual({
      kind: "user",
      principal_id: PERSON,
      provider: "oidc",
      product_id: null,
      verified_by: "browser_session",
      channel: "cockpit",
      origin_execution_id: null,
    });
  });

  test("a scheduled run names the engine instead of inventing a person", () => {
    const caller = describeExecutionCaller({
      id: RUN,
      request_source: "scheduler",
      authority_root_execution_id: null,
      caller_context: null,
      authorization_context: null,
    });
    expect(caller.kind).toBe("engine");
    expect(caller.principal_id).toBeNull();
    expect(caller.verified_by).toBeNull();
    expect(caller.channel).toBe("scheduler");
  });

  test("a nested run keeps pointing at the run that was originally asked for", () => {
    const nested = describeExecutionCaller({
      id: RUN,
      request_source: "workflow",
      authority_root_execution_id: ROOT,
      caller_context: null,
      authorization_context: null,
    });
    const root = describeExecutionCaller({
      id: ROOT,
      request_source: "api",
      authority_root_execution_id: ROOT,
      caller_context: null,
      authorization_context: null,
    });
    expect(nested.origin_execution_id).toBe(ROOT);
    expect(root.origin_execution_id).toBeNull();
  });

  test("the credential behind a run never leaves the engine", () => {
    const caller = describeExecutionCaller({
      id: RUN,
      request_source: "api",
      authority_root_execution_id: null,
      caller_context: null,
      authorization_context: {
        source: {
          kind: "api_key",
          api_key_id: "66666666-6666-4666-8666-666666666666",
          credential_version: "secret-version",
        },
      },
    });
    const text = JSON.stringify(caller);
    expect(caller.verified_by).toBe("api_key");
    expect(text).not.toContain("66666666");
    expect(text).not.toContain("secret-version");
  });
});
