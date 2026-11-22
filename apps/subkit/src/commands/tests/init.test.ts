import { describe, expect, test } from "bun:test";
import { initCommand, isLoopbackEngine, runInit } from "../init.ts";

const cmd = initCommand as unknown as {
  meta: { name: string; description: string };
  args: Record<string, { type: string; description?: string }>;
};

describe("subkit init — citty surface", () => {
  test("meta.name is 'init'", () => {
    expect(cmd.meta.name).toBe("init");
  });

  test("meta.description mentions bootstrap", () => {
    expect(cmd.meta.description.toLowerCase()).toContain("bootstrap");
  });

  test("declares --token + the four headless flags", () => {
    expect(cmd.args.token).toBeDefined();
    expect(cmd.args["admin-email"]).toBeDefined();
    expect(cmd.args["tenant-name"]).toBeDefined();
    expect(cmd.args["llm-provider"]).toBeDefined();
    expect(cmd.args["llm-api-key"]).toBeDefined();
  });

  test("declares --llm-model for providers that need a model or deployment name", () => {
    expect(cmd.args["llm-model"]).toBeDefined();
    expect(cmd.args["llm-model"]?.description).toContain("azure");
  });

  test("declares --engine-url and --profile", () => {
    expect(cmd.args["engine-url"]).toBeDefined();
    expect(cmd.args.profile).toBeDefined();
  });
});

describe("runInit — happy path", () => {
  test("posts to /v1/setup, saves the profile, returns exit code 0", async () => {
    let capturedRequest: { url: string; init: RequestInit } | null = null;
    let savedProfile: { name: string; api_key: string; engine_url: string } | null = null;
    const out: string[] = [];

    const result = await runInit({
      payload: {
        token: "a".repeat(64),
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "anthropic",
        llm_api_key: "sk-ant-x",
      },
      engine_url: "http://engine.test",
      profile: "default",
      out: (l) => out.push(l),
      err: () => undefined,
      fetchImpl: ((url: string, init?: RequestInit) => {
        capturedRequest = { url, init: init ?? {} };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              tenant_id: "11111111-1111-1111-1111-111111111111",
              user_id: "22222222-2222-2222-2222-222222222222",
              api_key: "wf_live_test_plaintext",
              api_key_prefix: "wf_live_test",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }) as unknown as typeof fetch,
      saveProfileImpl: ((p) => {
        savedProfile = { name: p.name, api_key: p.api_key, engine_url: p.engine_url };
      }) as typeof import("../../config.ts").saveProfile,
    });

    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.url).toBe("http://engine.test/v1/setup");
    const sentBody = JSON.parse(String(capturedRequest!.init.body)) as Record<string, unknown>;
    expect(sentBody.token).toBe("a".repeat(64));
    expect(sentBody.admin_email).toBe("ops@example.com");
    expect(savedProfile).not.toBeNull();
    expect(savedProfile!.api_key).toBe("wf_live_test_plaintext");
    expect(out.join("")).toContain("bootstrap complete");
  });
});

describe("runInit — failure modes", () => {
  test("410 Gone surfaces the gone code and prints next-step guidance", async () => {
    const errs: string[] = [];
    const result = await runInit({
      payload: {
        token: "a".repeat(64),
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      engine_url: "http://engine.test",
      profile: "default",
      out: () => undefined,
      err: (l) => errs.push(l),
      fetchImpl: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "gone", message: "bootstrap already completed" }), {
            status: 410,
            headers: { "content-type": "application/json" },
          }),
        )) as unknown as typeof fetch,
      saveProfileImpl: () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("gone");
    expect(result.exitCode).toBe(2);
    expect(errs.join("")).toContain("already been bootstrapped");
  });

  test("401 invalid_token surfaces the engine's code", async () => {
    const result = await runInit({
      payload: {
        token: "a".repeat(64),
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      engine_url: "http://engine.test",
      profile: "default",
      out: () => undefined,
      err: () => undefined,
      fetchImpl: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "invalid_token", message: "bad token" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        )) as unknown as typeof fetch,
      saveProfileImpl: () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_token");
    expect(result.error?.httpStatus).toBe(401);
  });

  test("401 token_expired renders the engine's re-mint hint", async () => {
    const errLines: string[] = [];
    const result = await runInit({
      payload: {
        token: "a".repeat(64),
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      engine_url: "http://engine.test",
      profile: "default",
      out: () => undefined,
      err: (line) => {
        errLines.push(line);
      },
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: "token_expired",
              message: "bootstrap token expired",
              hint: "a fresh token was just printed to the engine logs — copy the new `subkit init --token <token>` command from there and re-run it",
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
        )) as unknown as typeof fetch,
      saveProfileImpl: () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("token_expired");
    const all = errLines.join("");
    expect(all).toContain("hint:");
    expect(all).toContain("fresh token");
  });

  test("401 token_expired without an engine hint falls back to the fixed remediation", async () => {
    const errLines: string[] = [];
    await runInit({
      payload: {
        token: "a".repeat(64),
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      engine_url: "http://engine.test",
      profile: "default",
      out: () => undefined,
      err: (line) => {
        errLines.push(line);
      },
      fetchImpl: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "token_expired", message: "expired" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        )) as unknown as typeof fetch,
      saveProfileImpl: () => undefined,
    });
    const all = errLines.join("");
    expect(all).toContain("hint:");
    expect(all).toContain("15 minutes");
  });

  test("422 llm_unreachable names the refused key, saves no profile and keeps the token usable", async () => {
    const errLines: string[] = [];
    let saved = false;
    const result = await runInit({
      payload: {
        token: "a".repeat(64),
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "anthropic",
        llm_api_key: "sk-ant-wrong",
      },
      engine_url: "http://engine.test",
      profile: "default",
      out: () => undefined,
      err: (line) => {
        errLines.push(line);
      },
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: "llm_unreachable",
              message: "the LLM access check failed: anthropic rejected the API key (HTTP 401)",
              hint: "nothing was saved — no tenant, no key; fix the key or the provider and run `subkit init` again with the same token",
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
        )) as unknown as typeof fetch,
      saveProfileImpl: () => {
        saved = true;
      },
    });
    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        exitCode: 2,
        error: expect.objectContaining({ code: "llm_unreachable", httpStatus: 422 }),
      }),
    );
    expect(saved).toBe(false);
    const all = errLines.join("");
    expect(all).toContain("anthropic rejected the API key (HTTP 401)");
    expect(all).toContain("hint: nothing was saved");
    expect(all).toContain("same token");
    expect(all).not.toContain("sk-ant-wrong");
  });

  test("422 llm_unreachable without an engine hint still says nothing was saved", async () => {
    const errLines: string[] = [];
    await runInit({
      payload: {
        token: "a".repeat(64),
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "openai",
        llm_api_key: "x",
      },
      engine_url: "http://engine.test",
      profile: "default",
      out: () => undefined,
      err: (line) => {
        errLines.push(line);
      },
      fetchImpl: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "llm_unreachable", message: "probe failed" }), {
            status: 422,
            headers: { "content-type": "application/json" },
          }),
        )) as unknown as typeof fetch,
      saveProfileImpl: () => undefined,
    });
    const all = errLines.join("");
    expect(all).toContain("hint: nothing was saved");
    expect(all).toContain("--llm-api-key");
  });

  test("409 in_progress says another first start is running", async () => {
    const errLines: string[] = [];
    const result = await runInit({
      payload: {
        token: "a".repeat(64),
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      engine_url: "http://engine.test",
      profile: "default",
      out: () => undefined,
      err: (line) => {
        errLines.push(line);
      },
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ code: "in_progress", message: "another first start is running" }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        )) as unknown as typeof fetch,
      saveProfileImpl: () => undefined,
    });
    expect(result.error?.code).toBe("in_progress");
    expect(errLines.join("")).toContain("retry with the same token");
  });

  test("network error returns engine_unreachable", async () => {
    const result = await runInit({
      payload: {
        token: "a".repeat(64),
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      engine_url: "http://no-such-host.invalid",
      profile: "default",
      out: () => undefined,
      err: () => undefined,
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
      saveProfileImpl: () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("engine_unreachable");
  });
});

describe("isLoopbackEngine", () => {
  test("accepts engines on this machine", () => {
    for (const url of [
      "http://localhost:5050",
      "http://LOCALHOST:5050/",
      "http://127.0.0.1:5050",
      "http://127.1.2.3",
      "http://[::1]:5050",
    ])
      expect(isLoopbackEngine(url)).toBe(true);
  });

  test("refuses remote engines, look-alike hosts and invalid URLs", () => {
    for (const url of [
      "https://engine.example.com",
      "http://localhost.example.com",
      "http://127.0.0.1.example.com",
      "http://10.0.0.1:5050",
      "not a url",
    ])
      expect(isLoopbackEngine(url)).toBe(false);
  });
});
