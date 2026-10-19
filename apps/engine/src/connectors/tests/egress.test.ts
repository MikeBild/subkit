import { describe, expect, mock, test } from "bun:test";
import { withContext } from "../../logging/context.ts";
import { injectTraceContext, scrubUrl, withEgressAudit } from "../egress.ts";

const noopAudit = async () => undefined;

describe("scrubUrl", () => {
  test("redacts URL userinfo and PostgreSQL credential-bearing query parameters", () => {
    const output = scrubUrl(
      "postgresql://synthetic-user:synthetic-password@db.example.test/data?password=synthetic-query",
    );
    expect(output).not.toContain("synthetic-user");
    expect(output).not.toContain("synthetic-password");
    expect(output).not.toContain("synthetic-query");
    expect(output).toContain("db.example.test/data");
  });
  test("masks sensitive query params, keeps host + path", () => {
    const out = scrubUrl("https://api.example.com/v1/users?token=abc&limit=10");
    expect(out).toContain("api.example.com");
    expect(out).toContain("/v1/users");
    expect(out).toContain("token=***");
    expect(out).toContain("limit=10");
    expect(out).not.toContain("abc");
  });

  test("scrubs every known sensitive key", () => {
    const url = new URL("https://x.test/p");
    for (const k of [
      "token",
      "access_token",
      "refresh_token",
      "id_token",
      "api_key",
      "apikey",
      "key",
      "secret",
      "client_secret",
      "password",
      "signature",
      "sig",
      "x-amz-signature",
      "x-amz-credential",
    ]) {
      url.searchParams.set(k, "leaked");
    }
    const out = scrubUrl(url);
    expect(out).not.toContain("leaked");
    for (const k of url.searchParams.keys()) {
      expect(out).toContain(`${k}=***`);
    }
  });

  test("returns input unchanged on parse failure", () => {
    expect(scrubUrl("not a url")).toBe("not a url");
  });
});

describe("injectTraceContext", () => {
  test("injects traceparent when context has trace_id", () => {
    const headers: Record<string, string> = {};
    withContext({ trace_id: "abc123def456" }, () => {
      injectTraceContext(headers);
    });
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers.traceparent).toContain("abc123def456");
  });

  test("no-op when context has no trace_id", () => {
    const headers: Record<string, string> = {};
    injectTraceContext(headers);
    expect(headers.traceparent).toBeUndefined();
  });

  test("does not overwrite a pre-existing traceparent", () => {
    const headers = { traceparent: "preset" };
    withContext({ trace_id: "abc123def456" }, () => {
      injectTraceContext(headers);
    });
    expect(headers.traceparent).toBe("preset");
  });
});

describe("withEgressAudit", () => {
  test("returns the inner result verbatim and emits CONNECTOR_INVOKED on success", async () => {
    const result = await withEgressAudit(
      {
        tenant_id: "tenant-x",
        actor_id: "actor-y",
        connector_id: "cn-1",
        connector_slug: "cn-test",
        driver: "http",
        credential_id: null,
        url: "https://api.example.com/v1/foo?token=secret",
      },
      async () => ({ status: 200, body: "ok" }),
      (r) => ({ status: r.status }),
      noopAudit,
    );
    expect(result).toEqual({ status: 200, body: "ok" });
  });

  test("emits the canonical product-statistics metadata alongside legacy aliases", async () => {
    const entries: Array<Record<string, unknown>> = [];
    await withEgressAudit(
      {
        tenant_id: "tenant-x",
        actor_id: "actor-y",
        connector_id: "cn-1",
        connector_slug: "cn-test",
        driver: "http",
        credential_id: null,
        operation: "GET",
        url: "https://api.example.com/v1/items/42?token=secret",
      },
      async () => ({ status: 204 }),
      (result) => ({ status: result.status }),
      async (entry) => {
        entries.push(entry as Record<string, unknown>);
      },
    );

    const invoked = entries.find((entry) => entry.action === "connector.invoked");
    expect(invoked).toBeDefined();
    const metadata = invoked?.metadata as Record<string, unknown>;
    expect(metadata.connector_id).toBe("cn-1");
    expect(metadata.method).toBe("GET");
    expect(metadata.path).toBe("/v1/items/42");
    expect(metadata.status_code).toBe(204);
    expect(metadata.latency_ms).toBeNumber();
    expect(metadata.status).toBe(204);
    expect(metadata.duration_ms).toBeNumber();
  });

  test("preserves typed system-account attribution and keeps legacy IDs unknown", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const run = async (actor_type?: "system_account") =>
      withEgressAudit(
        {
          tenant_id: "tenant-x",
          actor_id: "actor-y",
          ...(actor_type ? { actor_type } : {}),
          connector_id: "cn-1",
          connector_slug: "cn-test",
          driver: "http",
          credential_id: null,
        },
        async () => ({ status: 204 }),
        undefined,
        async (entry) => {
          entries.push(entry as Record<string, unknown>);
        },
      );

    await run("system_account");
    await run();
    const invoked = entries.filter((entry) => entry.action === "connector.invoked");
    expect(invoked.map(({ actor_type, actor_id }) => ({ actor_type, actor_id }))).toEqual([
      { actor_type: "system_account", actor_id: "actor-y" },
      { actor_type: "unknown", actor_id: null },
    ]);
  });

  test("re-throws inner errors without swallowing", async () => {
    const boom = new Error("upstream 503");
    let caught: unknown = null;
    try {
      await withEgressAudit(
        {
          tenant_id: "tenant-x",
          actor_id: "actor-y",
          connector_id: "cn-1",
          connector_slug: "cn-test",
          driver: "http",
          credential_id: null,
        },
        async () => {
          throw boom;
        },
        undefined,
        noopAudit,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
  });

  test("late-bound credential_id from the result is honoured", async () => {
    const result = await withEgressAudit(
      {
        tenant_id: "tenant-x",
        actor_id: null,
        connector_id: "cn-1",
        connector_slug: "cn-test",
        driver: "graphql",
        credential_id: null,
      },
      async () => ({ status: 200, credential_id: "cred-late" }),
      (r) => ({ status: r.status }),
      noopAudit,
    );
    expect(result.credential_id).toBe("cred-late");
  });
});

void mock;
