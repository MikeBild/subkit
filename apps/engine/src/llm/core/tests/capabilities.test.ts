import { describe, expect, it } from "bun:test";
import {
  getStaticCapabilities,
  pickPdfStrategy,
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

describe("pickPdfStrategy", () => {
  const fullCaps = getStaticCapabilities("anthropic"); // filesApiSupport=true, supportsFile=true, supportsImage=true

  it("returns 'text' when hasTextLayer=true, regardless of file size or provider", () => {
    expect(pickPdfStrategy(fullCaps, 100 * 1024 * 1024, true)).toBe("text");
    expect(pickPdfStrategy(getStaticCapabilities("mock"), 1, true)).toBe("text");
    expect(
      pickPdfStrategy(
        {
          supportsImage: false,
          supportsFile: false,
          supportsAudio: false,
          supportsVideo: false,
          maxFileSizeMB: 0,
          maxPdfPages: 0,
          filesApiSupport: false,
        },
        0,
        true,
      ),
    ).toBe("text");
  });

  it("returns 'file_api' when filesApiSupport=true and file > 5MB", () => {
    const fileSizeBytes = 6 * 1024 * 1024; // 6 MB
    expect(pickPdfStrategy(fullCaps, fileSizeBytes, false)).toBe("file_api");
  });

  it("returns 'file_part' when supportsFile=true and file <= maxFileSizeMB (no filesApi needed)", () => {
    const caps = { ...fullCaps, filesApiSupport: false }; // force no Files API path
    const fileSizeBytes = 4 * 1024 * 1024; // 4 MB — under 5 MB threshold and under maxFileSizeMB
    expect(pickPdfStrategy(caps, fileSizeBytes, false)).toBe("file_part");
  });

  it("returns 'file_part' when filesApiSupport=true but file < 5MB", () => {
    // filesApiSupport=true but mb <= 5, so file_api is NOT chosen; falls to file_part
    const fileSizeBytes = 3 * 1024 * 1024; // 3 MB
    expect(pickPdfStrategy(fullCaps, fileSizeBytes, false)).toBe("file_part");
  });

  it("returns 'images' when supportsFile=false but supportsImage=true", () => {
    const caps = { ...fullCaps, supportsFile: false, filesApiSupport: false };
    const fileSizeBytes = 1 * 1024 * 1024;
    expect(pickPdfStrategy(caps, fileSizeBytes, false)).toBe("images");
  });

  it("throws when provider supports neither file nor image", () => {
    const caps = {
      supportsImage: false,
      supportsFile: false,
      supportsAudio: false,
      supportsVideo: false,
      maxFileSizeMB: 0,
      maxPdfPages: 0,
      filesApiSupport: false,
    };
    expect(() => pickPdfStrategy(caps, 1024, false)).toThrow("AI_UnsupportedFunctionalityError");
  });

  it("returns 'file_api' for a large file (> 5MB) with filesApiSupport=true even when supportsFile=false", () => {
    const caps = { ...fullCaps, supportsFile: false };
    const fileSizeBytes = 10 * 1024 * 1024;
    expect(pickPdfStrategy(caps, fileSizeBytes, false)).toBe("file_api");
  });
});
