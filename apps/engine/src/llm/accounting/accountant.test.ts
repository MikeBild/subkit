// Pins `inferProvider` — the bounded model-id → vendor-label classifier used
// for LLM-usage telemetry. Open-weight families (qwen / mistral / glm / deepseek /
// llama) must map to stable named buckets rather than collapsing into "other".

import { describe, expect, it } from "bun:test";

import { inferProvider } from "./accountant.ts";

describe("inferProvider", () => {
  it("classifies open-weight families into named buckets", () => {
    expect(inferProvider("qwen-3.6-27b")).toBe("qwen");
    expect(inferProvider("ministral-3-14b-instruct")).toBe("mistral");
    expect(inferProvider("mistral-large")).toBe("mistral");
    expect(inferProvider("mixtral-8x7b")).toBe("mistral");
    expect(inferProvider("glm-4.6")).toBe("glm");
    expect(inferProvider("deepseek-v3")).toBe("deepseek");
    expect(inferProvider("llama-3.3-70b")).toBe("meta");
  });

  it("keeps the existing commercial-provider classification (no regression)", () => {
    expect(inferProvider("claude-sonnet-4-6")).toBe("anthropic");
    expect(inferProvider("gpt-4o")).toBe("openai");
    expect(inferProvider("o3-mini")).toBe("openai");
    expect(inferProvider("gemini-2.0-flash")).toBe("google");
  });

  it("falls back to 'other' for unknown ids", () => {
    expect(inferProvider("some-unknown-model")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(inferProvider("QWEN-3-32B")).toBe("qwen");
  });
});
