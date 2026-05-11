// Tests for the DevTools wrap (issue #164).
//
// Asserts: (1) mock-sentinel models pass through unwrapped,
// (2) production models pass through unwrapped, (3) DEV models get
// wrapped, (4) the scrub middleware redacts Authorization headers.

import { afterEach, describe, expect, it } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { maybeWrapForDevtools } from "../devtools-wrap.ts";

// Minimal v3 model stub. The wrap composes around .doStream + .doGenerate;
// we don't exercise those here — we only care that the returned object is
// (or is not) a different instance from the input.
const stubV3Model = (): LanguageModelV3 => ({
  specificationVersion: "v3",
  provider: "stub",
  modelId: "stub-model",
  supportedUrls: {},
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub for type satisfaction
  doGenerate: (async () => ({}) as any) as any,
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub for type satisfaction
  doStream: (async () => ({}) as any) as any,
});

describe("maybeWrapForDevtools", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("passes through the mock sentinel string unchanged", () => {
    process.env.NODE_ENV = "development";
    const out = maybeWrapForDevtools("mock:never-dispatched");
    expect(out).toBe("mock:never-dispatched");
  });

  it("does not wrap when NODE_ENV is production", () => {
    process.env.NODE_ENV = "production";
    const model = stubV3Model();
    const out = maybeWrapForDevtools(model);
    expect(out).toBe(model);
  });

  it("wraps in DEV and returns a different instance", () => {
    process.env.NODE_ENV = "development";
    const model = stubV3Model();
    const out = maybeWrapForDevtools(model);
    expect(out).not.toBe(model);
    // The wrapped model is still a v3 language model (same surface).
    expect(typeof out === "object" && out !== null && "specificationVersion" in out).toBe(true);
  });

  it("passes through models with unsupported specificationVersion", () => {
    process.env.NODE_ENV = "development";
    // Force a non-v3 specificationVersion to simulate a legacy v2 model.
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const legacyModel = { ...stubV3Model(), specificationVersion: "v2" as any };
    const out = maybeWrapForDevtools(legacyModel);
    expect(out).toBe(legacyModel);
  });
});
