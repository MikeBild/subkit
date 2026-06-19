// PDF strategy — text extraction via `pdf-parse`.
//
// Native (text-layer) PDFs only; scanned PDFs without an embedded text
// layer return a sparse-or-empty string. The caller is responsible for
// detecting "too little extracted text" and re-routing to a vision path.
//
// Dep surface note: dropping `pdfjs-dist` as a *direct* dependency in
// favour of `pdf-parse` does NOT shrink the install tree — `pdf-parse`
// transitively re-pulls `pdfjs-dist` (and on some platforms
// `@napi-rs/canvas`). The win is a smaller direct-dep surface and one
// canonical Node-friendly extraction API; build-image size is unchanged.
//
// `pdf-parse` is imported *lazily* inside `parse()` — `pdfjs-dist`
// references browser globals (`DOMMatrix`) at module-evaluation time,
// so a top-level import would crash engine boot on any build where the
// `@napi-rs/canvas` polyfill native is absent. Loading it on first PDF
// parse keeps boot independent of the PDF toolchain. `import type` is
// erased at compile time and triggers no module evaluation.

import type { PDFParse } from "pdf-parse";
import {
  BinaryParseError,
  DetectionPriority,
  type FileParsingStrategy,
  PARSER_TIMEOUT_MS,
  withParserTimeout,
} from "./strategy.ts";

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
export const PDF_PAGE_SEPARATOR = "\n\n---\n\n";

export interface PdfParseOutput {
  format: "pdf";
  text: string;
  pages: number;
}

export const pdfStrategy: FileParsingStrategy<PdfParseOutput> = {
  format: "pdf",
  priority: DetectionPriority.BINARY_SIGNATURE,

  canHandle(buffer: Buffer): boolean {
    if (buffer.length < PDF_MAGIC.length) return false;
    return buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
  },

  async parse(buffer: Buffer): Promise<PdfParseOutput> {
    return withParserTimeout("pdf", PARSER_TIMEOUT_MS.pdf, async () => {
      const pdfModule = await import("pdf-parse").catch((err: unknown) => {
        throw new BinaryParseError("pdf", "pdf: PDF toolchain failed to load", { cause: err });
      });
      let parser: PDFParse;
      try {
        parser = new pdfModule.PDFParse({ data: new Uint8Array(buffer) });
      } catch (err) {
        throw new BinaryParseError("pdf", "pdf: failed to load document", { cause: err });
      }
      try {
        const result = await parser.getText();
        const text = result.pages.map((p) => p.text).join(PDF_PAGE_SEPARATOR);
        return { format: "pdf", text, pages: result.pages.length };
      } catch (err) {
        throw new BinaryParseError("pdf", "pdf: failed to extract text", { cause: err });
      } finally {
        try {
          await parser.destroy();
        } catch {
          // destroy errors are not actionable here.
        }
      }
    });
  },
};
