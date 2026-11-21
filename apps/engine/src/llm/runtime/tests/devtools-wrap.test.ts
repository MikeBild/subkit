import { afterEach, describe, expect, it } from "bun:test";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import {
  __resetDevtoolsCacheForTests,
  maybeWrapForDevtools,
  scrubAuthHeadersMiddleware,
} from "../devtools-wrap.ts";

type StubModel = {
  specificationVersion: string;
  provider: string;
  modelId: string;
  supportedUrls: Record<string, RegExp[]>;
  doGenerate: () => Promise<unknown>;
  doStream: () => Promise<unknown>;
};

const stubV4Model = (): StubModel => ({
  specificationVersion: "v4",
  provider: "stub",
  modelId: "stub-model",
  supportedUrls: {},
  doGenerate: async () => ({}),
  doStream: async () => ({}),
});

describe("maybeWrapForDevtools", () => {
  const originalNodeEnv = testEnv.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete testEnv.NODE_ENV;
    else testEnv.NODE_ENV = originalNodeEnv;
    __resetDevtoolsCacheForTests();
  });

  it("passes through the mock sentinel string unchanged", async () => {
    testEnv.NODE_ENV = "development";
    const out = await maybeWrapForDevtools("mock:never-dispatched");
    expect(out).toBe("mock:never-dispatched");
  });

  it("does not wrap when NODE_ENV is production", async () => {
    testEnv.NODE_ENV = "production";
    const model = stubV4Model();
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    const out = await maybeWrapForDevtools(model as any);
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    expect(out).toBe(model as any);
  });

  it("wraps in DEV and returns a different instance", async () => {
    testEnv.NODE_ENV = "development";
    const model = stubV4Model();
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    const out = await maybeWrapForDevtools(model as any);
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    expect(out).not.toBe(model as any);
    expect(typeof out === "object" && out !== null && "specificationVersion" in out).toBe(true);
  });

  for (const env of ["", "staging", "test", "smoke"] as const) {
    it(`does not wrap when NODE_ENV is ${env === "" ? "unset" : `"${env}"`}`, async () => {
      if (env === "") delete testEnv.NODE_ENV;
      else testEnv.NODE_ENV = env;
      const model = stubV4Model();
      // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
      const out = await maybeWrapForDevtools(model as any);
      // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
      expect(out).toBe(model as any);
    });
  }

  it("passes through models with unsupported specificationVersion", async () => {
    testEnv.NODE_ENV = "development";
    const legacyModel = { ...stubV4Model(), specificationVersion: "v2" };
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    const out = await maybeWrapForDevtools(legacyModel as any);
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the runtime contract
    expect(out).toBe(legacyModel as any);
  });
});

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

  it("scrub middleware runs before downstream middleware sees params", async () => {
    const { wrapLanguageModel } = await import("ai");
    const observed: Array<{ which: string; auth: string | undefined }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: probe middleware is intentionally minimal — full v3 surface would dwarf the assertion.
    const probe: any = (label: string) => ({
      specificationVersion: "v4" as const,
      // biome-ignore lint/suspicious/noExplicitAny: see above
      transformParams: async ({ params }: any) => {
        observed.push({ which: label, auth: params.headers?.Authorization });
        return params;
      },
    });
    const model = stubV4Model();
    const wrapped = wrapLanguageModel({
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for LanguageModelV3
      model: model as any,
      middleware: [scrubAuthHeadersMiddleware, probe("inner")],
    });
    const inner = wrapped as unknown as {
      doGenerate: (opts: {
        prompt: unknown[];
        headers: Record<string, string>;
      }) => Promise<unknown>;
    };
    await inner.doGenerate({ prompt: [], headers: { Authorization: "Bearer sk-secret" } });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.which).toBe("inner");
    expect(observed[0]?.auth).toBe("[REDACTED]");
  });
});
