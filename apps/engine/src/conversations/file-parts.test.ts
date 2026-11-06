import { describe, expect, test } from "bun:test";
import { toAiSdkParts } from "./persistence/index.ts";

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
