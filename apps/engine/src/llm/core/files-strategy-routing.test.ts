// `chooseFileStrategy` decision-matrix tests.
//
// Mirrors the style of `capabilities.test.ts` (which covers `pickPdfStrategy`)
// so the two decision trees are tested symmetrically. No I/O, no LLM calls.

import { describe, expect, test } from "bun:test";
import {
  chooseFileStrategy,
  getStaticCapabilities,
  type ModelCapabilities,
} from "./capabilities.ts";

const MB = 1024 * 1024;

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

describe("chooseFileStrategy", () => {
  test("small file + filesApiSupport=true → file_part (≤ 5 MB threshold)", () => {
    // 5 MB exactly is NOT over the threshold (strictly > 5 MB triggers file_api)
    expect(chooseFileStrategy(withFilesApi, 5 * MB)).toBe("file_part");
  });

  test("file just below 5 MB threshold + filesApiSupport=true → file_part", () => {
    expect(chooseFileStrategy(withFilesApi, 5 * MB - 1)).toBe("file_part");
  });

  test("large file (> 5 MB) + filesApiSupport=true → file_api", () => {
    expect(chooseFileStrategy(withFilesApi, 6 * MB)).toBe("file_api");
  });

  test("file exactly at 5 MB + 1 byte + filesApiSupport=true → file_api", () => {
    expect(chooseFileStrategy(withFilesApi, 5 * MB + 1)).toBe("file_api");
  });

  test("small file + filesApiSupport=false + supportsFile=true → file_part", () => {
    expect(chooseFileStrategy(noFilesApi, 1 * MB)).toBe("file_part");
  });

  test("file exceeding maxFileSizeMB + filesApiSupport=false → text_extract", () => {
    // anthropic.maxFileSizeMB = 32; send 33 MB with no filesApiSupport
    expect(chooseFileStrategy(noFilesApi, 33 * MB)).toBe("text_extract");
  });

  test("no file support at all → text_extract", () => {
    expect(chooseFileStrategy(noFileSupport, 1 * MB)).toBe("text_extract");
  });

  test("zero-byte file + filesApiSupport=false + supportsFile=true → file_part", () => {
    expect(chooseFileStrategy(noFilesApi, 0)).toBe("file_part");
  });

  test("mock provider (filesApiSupport=false, maxFileSizeMB=32) routes file_part for small files", () => {
    const mockCaps = getStaticCapabilities("mock");
    expect(chooseFileStrategy(mockCaps, 1 * MB)).toBe("file_part");
  });

  test("mock provider routes text_extract for oversized files", () => {
    const mockCaps = getStaticCapabilities("mock");
    expect(chooseFileStrategy(mockCaps, 33 * MB)).toBe("text_extract");
  });

  test("azure provider (filesApiSupport=false) always stays in file_part / text_extract lane", () => {
    const azureCaps = getStaticCapabilities("azure");
    expect(chooseFileStrategy(azureCaps, 1 * MB)).toBe("file_part");
    // azure.maxFileSizeMB = 32; 33 MB → text_extract
    expect(chooseFileStrategy(azureCaps, 33 * MB)).toBe("text_extract");
  });

  test("large file + filesApiSupport=true is always file_api regardless of supportsFile", () => {
    const caps: ModelCapabilities = { ...withFilesApi, supportsFile: false };
    expect(chooseFileStrategy(caps, 10 * MB)).toBe("file_api");
  });

  test("gemini (filesApiSupport=true, maxFileSizeMB=50) routes large files to file_api", () => {
    const geminiCaps = getStaticCapabilities("gemini");
    expect(chooseFileStrategy(geminiCaps, 6 * MB)).toBe("file_api");
    expect(chooseFileStrategy(geminiCaps, 4 * MB)).toBe("file_part");
  });
});
