// Tests for the DevTools wrap (issue #164).
//
// Asserts: (1) mock-sentinel models pass through unwrapped,
// (2) production models pass through unwrapped, (3) DEV models get
// wrapped, (4) the scrub middleware redacts Authorization headers.

import { afterEach, describe, expect, it } from "bun:test";
import {
  __resetDevtoolsCacheForTests,
  maybeWrapForDevtools,
  scrubAuthHeadersMiddleware,
} from "../devtools-wrap.ts";

// Minimal v3-shaped model stub. We do not import `@ai-sdk/provider` here
// because the `no_live_llm` audit invariant forbids real-LLM SDK imports
// in any *.test.ts file. The wrap composes around .doStream + .doGenerate;
// we don't exercise those — only that the returned reference is (or is
// not) the same instance.
type StubModel = {
  specificationVersion: string;
  provider: string;
  modelId: string;
  supportedUrls: Record<string, RegExp[]>;
  doGenerate: () => Promise<unknown>;
  doStream: () => Promise<unknown>;
};

const stubV3Model = (): StubModel => ({
  specificationVersion: "v3",
  provider: "stub",
  modelId: "stub-model",
  supportedUrls: {},
  doGenerate: async () => ({}),
  doStream: async () => ({}),
});

describe("maybeWrapForDevtools", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    // Reset the module-scoped middleware cache so cases that flip
    // NODE_ENV don't see each other's load decisions (S3).
    __resetDevtoolsCacheForTests();
  });

  it("passes through the mock sentinel string unchanged", async () => {
    process.env.NODE_ENV = "development";
    const out = await maybeWrapForDevtools("mock:never-dispatched");
    expect(out).toBe("mock:never-dispatched");
  });

  it("does not wrap when NODE_ENV is production", async () => {
    process.env.NODE_ENV = "production";
    const model = stubV3Model();
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    const out = await maybeWrapForDevtools(model as any);
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    expect(out).toBe(model as any);
  });

  it("wraps in DEV and returns a different instance", async () => {
    process.env.NODE_ENV = "development";
    const model = stubV3Model();
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    const out = await maybeWrapForDevtools(model as any);
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    expect(out).not.toBe(model as any);
    expect(typeof out === "object" && out !== null && "specificationVersion" in out).toBe(true);
  });

  it("passes through models with unsupported specificationVersion", async () => {
    process.env.NODE_ENV = "development";
    const legacyModel = { ...stubV3Model(), specificationVersion: "v2" };
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    const out = await maybeWrapForDevtools(legacyModel as any);
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    expect(out).toBe(legacyModel as any);
  });
});

// W5: assert the scrub middleware redacts auth headers before any
// downstream middleware (i.e. devtools) sees them. This is the
// secret-redaction guarantee load-bearing on the design comment in
// devtools-wrap.ts.
describe("scrubAuthHeadersMiddleware", () => {
  it("redacts Authorization / x-api-key / api-key / x-auth-token / x-amz-security-token", async () => {
    const transform = scrubAuthHeadersMiddleware.transformParams;
    if (!transform) throw new Error("scrubAuthHeadersMiddleware.transformParams missing");
    const result = await transform({
      type: "generate",
      params: {
        prompt: [],
        headers: {
          Authorization: "Bearer sk-secret",
          "X-Api-Key": "ak_live_xyz",
          "api-key": "kp_xyz",
          "X-Auth-Token": "tok_xyz",
          "x-amz-security-token": "sts_xyz",
          // Non-auth header — must pass through unchanged.
          "x-trace-id": "trace-1234",
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for the LanguageModelV3 surface
    } as any);
    // biome-ignore lint/suspicious/noExplicitAny: scrubbed result is shaped per LanguageModelV3 params
    const headers = (result as any).headers as Record<string, string>;
    expect(headers.Authorization).toBe("[REDACTED]");
    expect(headers["X-Api-Key"]).toBe("[REDACTED]");
    expect(headers["api-key"]).toBe("[REDACTED]");
    expect(headers["X-Auth-Token"]).toBe("[REDACTED]");
    expect(headers["x-amz-security-token"]).toBe("[REDACTED]");
    expect(headers["x-trace-id"]).toBe("trace-1234");
  });

  // S4: SDK middleware-order regression. `wrapLanguageModel` reverses
  // the array before reducing, so `[outer, inner]` means `outer` is
  // user-facing and `inner` sees scrubbed params. If a minor SDK bump
  // flips that contract, this test fails.
  it("scrub middleware runs before downstream middleware sees params", async () => {
    const { wrapLanguageModel } = await import("ai");
    const observed: Array<{ which: string; auth: string | undefined }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: probe middleware is intentionally minimal — full v3 surface would dwarf the assertion.
    const probe: any = (label: string) => ({
      specificationVersion: "v3" as const,
      // biome-ignore lint/suspicious/noExplicitAny: see above
      transformParams: async ({ params }: any) => {
        observed.push({ which: label, auth: params.headers?.Authorization });
        return params;
      },
    });
    const model = stubV3Model();
    const wrapped = wrapLanguageModel({
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for LanguageModelV3
      model: model as any,
      middleware: [scrubAuthHeadersMiddleware, probe("inner")],
    });
    const inner = wrapped as unknown as {
      doGenerate: (opts: { headers: Record<string, string> }) => Promise<unknown>;
    };
    await inner.doGenerate({ headers: { Authorization: "Bearer sk-secret" } });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.which).toBe("inner");
    expect(observed[0]?.auth).toBe("[REDACTED]");
  });
});
