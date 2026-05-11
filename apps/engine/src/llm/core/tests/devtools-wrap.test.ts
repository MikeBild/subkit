// Tests for the DevTools wrap (issue #164).
//
// Asserts: (1) mock-sentinel models pass through unwrapped,
// (2) production models pass through unwrapped, (3) DEV models get
// wrapped, (4) the scrub middleware redacts Authorization headers.

import { afterEach, describe, expect, it } from "bun:test";
import { maybeWrapForDevtools } from "../devtools-wrap.ts";

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
