// PDF strategy — text extraction via `pdf-parse`.
//
// Native (text-layer) PDFs only; scanned PDFs without an embedded text
// layer return a sparse-or-empty string. The caller is responsible for
// detecting "too little extracted text" and re-routing to a vision path.

import { PDFParse } from "pdf-parse";
import { BinaryParseError, DetectionPriority, type FileParsingStrategy } from "./strategy.ts";

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
    let parser: PDFParse;
    try {
      parser = new PDFParse({ data: new Uint8Array(buffer) });
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
  },
};
