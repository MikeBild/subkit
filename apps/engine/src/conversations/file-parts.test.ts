// `toAiSdkParts` reference-shape regression tests.
//
// The provider adapters (@ai-sdk/anthropic, @ai-sdk/openai,
// @ai-sdk/google) emit their native file-id blocks (Anthropic
// `document`/`image` file source, OpenAI `input_file`, Google
// `fileData`) ONLY when a FilePart carries
// `data: { type: "reference", reference: { [providerKey]: id } }`.
// Any other shape falls into the raw-bytes branch — a zero-byte
// `Uint8Array` there produces an EMPTY base64 document at the model.
// These tests lock the exact wire shape. No I/O, no LLM calls.

import { describe, expect, test } from "bun:test";
import type { FileContentBlock } from "../llm/core/file-context.ts";
import { toAiSdkParts } from "./persist.ts";

function fileApiBlock(provider: "anthropic" | "openai" | "gemini"): FileContentBlock {
  return {
    strategy: "file_api",
    file_id: `file_${provider}_123`,
    filename: "report.pdf",
    content_type: "application/pdf",
    provider,
  };
}

describe("toAiSdkParts — file_api reference shape", () => {
  test("anthropic block → FileDataReference keyed by 'anthropic'", () => {
    const parts = toAiSdkParts(fileApiBlock("anthropic"));
    expect(parts).toEqual([
      {
        type: "file",
        data: { type: "reference", reference: { anthropic: "file_anthropic_123" } },
        mediaType: "application/pdf",
        filename: "report.pdf",
      },
    ]);
  });

  test("openai block → FileDataReference keyed by 'openai'", () => {
    const parts = toAiSdkParts(fileApiBlock("openai"));
    expect(parts[0]).toMatchObject({
      type: "file",
      data: { type: "reference", reference: { openai: "file_openai_123" } },
    });
  });

  test("gemini block → FileDataReference keyed by 'google' (SDK provider key ≠ subkit provider kind)", () => {
    const parts = toAiSdkParts(fileApiBlock("gemini"));
    expect(parts[0]).toMatchObject({
      type: "file",
      data: { type: "reference", reference: { google: "file_gemini_123" } },
    });
  });

  test("file_api parts never carry raw data bytes", () => {
    const [part] = toAiSdkParts(fileApiBlock("anthropic"));
    expect(part).toBeDefined();
    if (part?.type === "file") {
      expect(part.data).not.toBeInstanceOf(Uint8Array);
    }
  });
});

describe("toAiSdkParts — file_part and text_extract", () => {
  test("image media → ImagePart with raw bytes", () => {
    const data = new Uint8Array([1, 2, 3]);
    const parts = toAiSdkParts({
      strategy: "file_part",
      filename: "pic.png",
      content_type: "image/png",
      mediaType: "image/png",
      data,
    });
    expect(parts).toEqual([{ type: "image", image: data, mediaType: "image/png" }]);
  });

  test("PDF media → FilePart with raw bytes", () => {
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const parts = toAiSdkParts({
      strategy: "file_part",
      filename: "doc.pdf",
      content_type: "application/pdf",
      mediaType: "application/pdf",
      data,
    });
    expect(parts).toEqual([
      { type: "file", data, mediaType: "application/pdf", filename: "doc.pdf" },
    ]);
  });

  test("text_extract → TextPart", () => {
    const parts = toAiSdkParts({
      strategy: "text_extract",
      filename: "notes.csv",
      content_type: "text/csv",
      text: "a,b\n1,2",
      placeholder: false,
    });
    expect(parts).toEqual([{ type: "text", text: "a,b\n1,2" }]);
  });
});
