import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetConfigForTests } from "../../../config/loader.ts";
import {
  chooseFileStrategy,
  getStaticCapabilities,
  resolveModelCapabilities,
} from "../capabilities.ts";

describe("getStaticCapabilities", () => {
  it("returns correct capabilities for anthropic", () => {
    const caps = getStaticCapabilities("anthropic");
    expect(caps.supportsImage).toBe(true);
    expect(caps.supportsFile).toBe(true);
    expect(caps.filesApiSupport).toBe(true);
    expect(caps.maxPdfPages).toBe(600);
  });

  it("returns correct capabilities for openai", () => {
    const caps = getStaticCapabilities("openai");
    expect(caps.supportsFile).toBe(true);
    expect(caps.maxPdfPages).toBe(100);
  });

  it("returns correct capabilities for gemini", () => {
    const caps = getStaticCapabilities("gemini");
    expect(caps.maxPdfPages).toBe(1000);
  });

  it("returns correct capabilities for azure", () => {
    const caps = getStaticCapabilities("azure");
    expect(caps.filesApiSupport).toBe(false);
    expect(caps.maxPdfPages).toBe(100);
  });

  it("returns correct capabilities for bedrock", () => {
    const caps = getStaticCapabilities("bedrock");
    expect(caps.filesApiSupport).toBe(false);
    expect(caps.maxPdfPages).toBe(200);
  });

  it("returns correct capabilities for vertex", () => {
    const caps = getStaticCapabilities("vertex");
    expect(caps.filesApiSupport).toBe(false);
    expect(caps.maxPdfPages).toBe(1000);
  });

  it("returns correct capabilities for mock", () => {
    const caps = getStaticCapabilities("mock");
    expect(caps.supportsImage).toBe(true);
    expect(caps.supportsFile).toBe(true);
    expect(caps.filesApiSupport).toBe(false);
    expect(caps.maxPdfPages).toBe(100);
  });
});

describe("getStaticCapabilities — OpenAI-compatible custom base_url gate", () => {
  let savedBaseUrl: string | undefined;
  beforeEach(() => {
    savedBaseUrl = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    // The predicate reads getConfig() first; drop any leaked config state so
    // the env-driven assertions below are authoritative.
    _resetConfigForTests();
  });
  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedBaseUrl;
    _resetConfigForTests();
  });

  it("disables Files API + audio/video for openai when a custom base_url is set", () => {
    process.env.OPENAI_BASE_URL = "https://llm.internal.example/v1";
    const caps = getStaticCapabilities("openai");
    expect(caps.filesApiSupport).toBe(false);
    expect(caps.supportsAudio).toBe(false);
    expect(caps.supportsVideo).toBe(false);
    // Inline paths and page cap are intentionally preserved.
    expect(caps.supportsImage).toBe(true);
    expect(caps.supportsFile).toBe(true);
    expect(caps.maxPdfPages).toBe(100);
  });

  it("leaves real OpenAI (no base_url) fully capable", () => {
    const caps = getStaticCapabilities("openai");
    expect(caps.filesApiSupport).toBe(true);
    expect(caps.supportsAudio).toBe(true);
    expect(caps.supportsVideo).toBe(true);
  });

  it("does not affect other providers when a custom openai base_url is set", () => {
    process.env.OPENAI_BASE_URL = "https://llm.internal.example/v1";
    expect(getStaticCapabilities("anthropic").filesApiSupport).toBe(true);
    expect(getStaticCapabilities("azure").filesApiSupport).toBe(false);
  });

  it("propagates the gate through resolveModelCapabilities", async () => {
    process.env.OPENAI_BASE_URL = "https://llm.internal.example/v1";
    const caps = await resolveModelCapabilities("openai", "qwen-3-32b");
    expect(caps.filesApiSupport).toBe(false);
  });

  it("routes files to inline/text-extract once Files API is gated off", () => {
    process.env.OPENAI_BASE_URL = "https://llm.internal.example/v1";
    const caps = getStaticCapabilities("openai"); // maxFileSizeMB stays 32
    // 6MB would have been file_api on real OpenAI; now inlined as file_part.
    expect(chooseFileStrategy(caps, 6 * 1024 * 1024, "application/pdf")).toBe("file_part");
    // Oversized (> maxFileSizeMB) falls back to text extraction.
    expect(chooseFileStrategy(caps, 40 * 1024 * 1024, "application/pdf")).toBe("text_extract");
  });
});

describe("resolveModelCapabilities", () => {
  it("resolves anthropic capabilities for a named model", async () => {
    const caps = await resolveModelCapabilities("anthropic", "claude-3-5-sonnet");
    expect(caps.supportsImage).toBe(true);
    expect(caps.supportsFile).toBe(true);
    expect(caps.filesApiSupport).toBe(true);
    expect(caps.maxPdfPages).toBe(600);
  });

  it("resolves openai capabilities for a named model", async () => {
    const caps = await resolveModelCapabilities("openai", "gpt-4o");
    expect(caps.supportsFile).toBe(true);
    expect(caps.maxPdfPages).toBe(100);
  });

  it("resolves gemini capabilities for a named model", async () => {
    const caps = await resolveModelCapabilities("gemini", "gemini-2.0-flash");
    expect(caps.maxPdfPages).toBe(1000);
  });

  it("returns a ModelCapabilities object (async)", async () => {
    const caps = await resolveModelCapabilities("mock", "any-model");
    expect(typeof caps.supportsImage).toBe("boolean");
    expect(typeof caps.supportsFile).toBe("boolean");
    expect(typeof caps.maxFileSizeMB).toBe("number");
    expect(typeof caps.maxPdfPages).toBe("number");
    expect(typeof caps.filesApiSupport).toBe("boolean");
  });
});

describe("chooseFileStrategy — PDF routing", () => {
  const fullCaps = getStaticCapabilities("anthropic"); // filesApiSupport=true, supportsFile=true, supportsImage=true
  const PDF = "application/pdf";

  it("returns 'file_api' when filesApiSupport=true and file > 5MB", () => {
    const fileSizeBytes = 6 * 1024 * 1024; // 6 MB
    expect(chooseFileStrategy(fullCaps, fileSizeBytes, PDF)).toBe("file_api");
  });

  it("returns 'file_part' when supportsFile=true and file <= maxFileSizeMB (no filesApi needed)", () => {
    const caps = { ...fullCaps, filesApiSupport: false }; // force no Files API path
    const fileSizeBytes = 4 * 1024 * 1024; // 4 MB — under 5 MB threshold and under maxFileSizeMB
    expect(chooseFileStrategy(caps, fileSizeBytes, PDF)).toBe("file_part");
  });

  it("returns 'file_part' when filesApiSupport=true but file < 5MB", () => {
    // filesApiSupport=true but mb <= 5, so file_api is NOT chosen; falls to file_part
    const fileSizeBytes = 3 * 1024 * 1024; // 3 MB
    expect(chooseFileStrategy(fullCaps, fileSizeBytes, PDF)).toBe("file_part");
  });

  it("returns 'text_extract' when provider supports neither file nor Files API", () => {
    const caps = {
      supportsImage: false,
      supportsFile: false,
      supportsAudio: false,
      supportsVideo: false,
      maxFileSizeMB: 0,
      maxPdfPages: 0,
      filesApiSupport: false,
    };
    expect(chooseFileStrategy(caps, 1024, PDF)).toBe("text_extract");
  });

  it("returns 'file_api' for a large file (> 5MB) with filesApiSupport=true even when supportsFile=false", () => {
    const caps = { ...fullCaps, supportsFile: false };
    const fileSizeBytes = 10 * 1024 * 1024;
    expect(chooseFileStrategy(caps, fileSizeBytes, PDF)).toBe("file_api");
  });
});
