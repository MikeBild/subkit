import { describe, expect, test } from "bun:test";
import {
  chooseFileStrategy,
  getStaticCapabilities,
  isProviderNativeMedia,
  type ModelCapabilities,
} from "./capabilities.ts";

const MB = 1024 * 1024;
const PDF = "application/pdf";
const PNG = "image/png";

const anthropicCaps: ModelCapabilities = { ...getStaticCapabilities("anthropic") };
const noFileSupport: ModelCapabilities = {
  ...getStaticCapabilities("anthropic"),
  supportsFile: false,
};

describe("isProviderNativeMedia", () => {
  test("images and PDFs are native", () => {
    expect(isProviderNativeMedia("image/png")).toBe(true);
    expect(isProviderNativeMedia("image/jpeg")).toBe(true);
    expect(isProviderNativeMedia("application/pdf")).toBe(true);
    expect(isProviderNativeMedia("APPLICATION/PDF")).toBe(true);
  });

  test("everything else is not", () => {
    expect(isProviderNativeMedia("text/csv")).toBe(false);
    expect(isProviderNativeMedia("application/json")).toBe(false);
    expect(
      isProviderNativeMedia(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(false);
    expect(isProviderNativeMedia(null)).toBe(false);
    expect(isProviderNativeMedia(undefined)).toBe(false);
    expect(isProviderNativeMedia("")).toBe(false);
  });
});

describe("chooseFileStrategy — size ladder for native media", () => {
  test("native media within maxFileSizeMB → file_part", () => {
    expect(chooseFileStrategy(anthropicCaps, 100 * 1024, PDF)).toBe("file_part");
    expect(chooseFileStrategy(anthropicCaps, 5 * MB, PDF)).toBe("file_part");
    expect(chooseFileStrategy(anthropicCaps, 20 * MB, PNG)).toBe("file_part");
    expect(chooseFileStrategy(anthropicCaps, 32 * MB, PDF)).toBe("file_part");
  });

  test("native media over maxFileSizeMB → text_extract", () => {
    expect(chooseFileStrategy(anthropicCaps, 33 * MB, PDF)).toBe("text_extract");
  });

  test("no file support → text_extract even for native media", () => {
    expect(chooseFileStrategy(noFileSupport, 1 * MB, PDF)).toBe("text_extract");
  });

  test("zero-byte native file → file_part", () => {
    expect(chooseFileStrategy(anthropicCaps, 0, PNG)).toBe("file_part");
  });

  test("gemini (maxFileSizeMB=50) inlines larger native files", () => {
    const geminiCaps = getStaticCapabilities("gemini");
    expect(chooseFileStrategy(geminiCaps, 40 * MB, PDF)).toBe("file_part");
    expect(chooseFileStrategy(geminiCaps, 51 * MB, PDF)).toBe("text_extract");
  });

  test("bedrock (maxFileSizeMB=20) caps the inline lane lower", () => {
    const bedrockCaps = getStaticCapabilities("bedrock");
    expect(chooseFileStrategy(bedrockCaps, 19 * MB, PDF)).toBe("file_part");
    expect(chooseFileStrategy(bedrockCaps, 21 * MB, PDF)).toBe("text_extract");
  });
});

describe("chooseFileStrategy — media gate", () => {
  test("non-native media always parses to text, regardless of size", () => {
    const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(chooseFileStrategy(anthropicCaps, 100 * 1024, DOCX)).toBe("text_extract");
    expect(chooseFileStrategy(anthropicCaps, 6 * MB, DOCX)).toBe("text_extract");
    expect(chooseFileStrategy(anthropicCaps, 100 * 1024, "text/csv")).toBe("text_extract");
    expect(chooseFileStrategy(anthropicCaps, 100 * 1024, "application/json")).toBe("text_extract");
  });

  test("unknown content type parses to text", () => {
    expect(chooseFileStrategy(anthropicCaps, 100 * 1024, null)).toBe("text_extract");
    expect(chooseFileStrategy(anthropicCaps, 100 * 1024, undefined)).toBe("text_extract");
  });
});
