// `chooseFileStrategy` decision-matrix tests.
//
// Mirrors the style of `capabilities.test.ts` so the size ladder and the
// media gate are tested symmetrically. No I/O, no LLM calls.

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

// Convenience constructors for the common cap variants.
const withFilesApi: ModelCapabilities = { ...getStaticCapabilities("anthropic") };
const noFilesApi: ModelCapabilities = {
  ...getStaticCapabilities("anthropic"),
  filesApiSupport: false,
};
const noFileSupport: ModelCapabilities = {
  ...getStaticCapabilities("anthropic"),
  supportsFile: false,
  filesApiSupport: false,
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
  test("small PDF + filesApiSupport=true → file_part (≤ 5 MB threshold)", () => {
    // 5 MB exactly is NOT over the threshold (strictly > 5 MB triggers file_api)
    expect(chooseFileStrategy(withFilesApi, 5 * MB, PDF)).toBe("file_part");
  });

  test("PDF just below 5 MB threshold + filesApiSupport=true → file_part", () => {
    expect(chooseFileStrategy(withFilesApi, 5 * MB - 1, PDF)).toBe("file_part");
  });

  test("large PDF (> 5 MB) + filesApiSupport=true → file_api", () => {
    expect(chooseFileStrategy(withFilesApi, 6 * MB, PDF)).toBe("file_api");
  });

  test("PDF exactly at 5 MB + 1 byte + filesApiSupport=true → file_api", () => {
    expect(chooseFileStrategy(withFilesApi, 5 * MB + 1, PDF)).toBe("file_api");
  });

  test("small image + filesApiSupport=false + supportsFile=true → file_part", () => {
    expect(chooseFileStrategy(noFilesApi, 1 * MB, PNG)).toBe("file_part");
  });

  test("PDF exceeding maxFileSizeMB + filesApiSupport=false → text_extract", () => {
    // anthropic.maxFileSizeMB = 32; send 33 MB with no filesApiSupport
    expect(chooseFileStrategy(noFilesApi, 33 * MB, PDF)).toBe("text_extract");
  });

  test("no file support at all → text_extract", () => {
    expect(chooseFileStrategy(noFileSupport, 1 * MB, PDF)).toBe("text_extract");
  });

  test("zero-byte image + filesApiSupport=false + supportsFile=true → file_part", () => {
    expect(chooseFileStrategy(noFilesApi, 0, PNG)).toBe("file_part");
  });

  test("mock provider (filesApiSupport=false, maxFileSizeMB=32) routes file_part for small native media", () => {
    const mockCaps = getStaticCapabilities("mock");
    expect(chooseFileStrategy(mockCaps, 1 * MB, PDF)).toBe("file_part");
  });

  test("mock provider routes text_extract for oversized files", () => {
    const mockCaps = getStaticCapabilities("mock");
    expect(chooseFileStrategy(mockCaps, 33 * MB, PDF)).toBe("text_extract");
  });

  test("azure provider (filesApiSupport=false) always stays in file_part / text_extract lane", () => {
    const azureCaps = getStaticCapabilities("azure");
    expect(chooseFileStrategy(azureCaps, 1 * MB, PDF)).toBe("file_part");
    // azure.maxFileSizeMB = 32; 33 MB → text_extract
    expect(chooseFileStrategy(azureCaps, 33 * MB, PDF)).toBe("text_extract");
  });

  test("large PDF + filesApiSupport=true is always file_api regardless of supportsFile", () => {
    const caps: ModelCapabilities = { ...withFilesApi, supportsFile: false };
    expect(chooseFileStrategy(caps, 10 * MB, PDF)).toBe("file_api");
  });

  test("native media over maxFileSizeMB but with Files API → file_api (upload + reference)", () => {
    // anthropic.maxFileSizeMB = 32; a 33 MB PDF can't inline but CAN upload
    expect(chooseFileStrategy(withFilesApi, 33 * MB, PDF)).toBe("file_api");
  });

  test("gemini (filesApiSupport=true, maxFileSizeMB=50) routes large files to file_api", () => {
    const geminiCaps = getStaticCapabilities("gemini");
    expect(chooseFileStrategy(geminiCaps, 6 * MB, PDF)).toBe("file_api");
    expect(chooseFileStrategy(geminiCaps, 4 * MB, PDF)).toBe("file_part");
  });
});

describe("chooseFileStrategy — media gate", () => {
  test("non-native media always parses to text, regardless of size or Files API", () => {
    const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    // The provider SDKs throw UnsupportedFunctionalityError for a raw
    // file part with these media types — they must never ride the
    // raw-bytes lanes.
    expect(chooseFileStrategy(withFilesApi, 100 * 1024, DOCX)).toBe("text_extract");
    expect(chooseFileStrategy(withFilesApi, 6 * MB, DOCX)).toBe("text_extract");
    expect(chooseFileStrategy(withFilesApi, 100 * 1024, "text/csv")).toBe("text_extract");
    expect(chooseFileStrategy(withFilesApi, 100 * 1024, "application/json")).toBe("text_extract");
  });

  test("unknown content type parses to text", () => {
    expect(chooseFileStrategy(withFilesApi, 100 * 1024, null)).toBe("text_extract");
    expect(chooseFileStrategy(withFilesApi, 100 * 1024, undefined)).toBe("text_extract");
  });
});
