// DOCX strategy — Office Open XML word document → markdown.
//
// Two-step pipeline:
//   1. `mammoth.convertToHtml({buffer})` — DOCX → HTML, preserving
//      headings, lists, tables, and inline formatting.
//   2. `NodeHtmlMarkdown.translate(html)` — HTML → markdown.
//
// Embedded images are stripped (replaced with an empty `src`) to keep
// the output text-only — keeps RawChunks small. mammoth doesn't expose
// `convertToMarkdown` in its TS types so we go through HTML explicitly.

import mammoth from "mammoth";
import { NodeHtmlMarkdown } from "node-html-markdown";

import {
  BinaryParseError,
  DetectionPriority,
  type FileParsingStrategy,
  PARSER_TIMEOUT_MS,
  withParserTimeout,
} from "./strategy.ts";
import { hasZipEntryPrefix } from "./zip-sniff.ts";

export interface DocxParseOutput {
  format: "docx";
  markdown: string;
}

const htmlToMarkdown = new NodeHtmlMarkdown();

export const docxStrategy: FileParsingStrategy<DocxParseOutput> = {
  format: "docx",
  priority: DetectionPriority.ZIP_BASED_SPECIFIC,

  canHandle(buffer: Buffer): boolean {
    return hasZipEntryPrefix(buffer, "word/");
  },

  async parse(buffer: Buffer): Promise<DocxParseOutput> {
    return withParserTimeout("docx", PARSER_TIMEOUT_MS.docx, async () => {
      try {
        const result = await mammoth.convertToHtml(
          { buffer },
          {
            convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
          },
        );
        const markdown = htmlToMarkdown.translate(result.value);
        return { format: "docx", markdown };
      } catch (err) {
        throw new BinaryParseError("docx", "docx: failed to convert document", { cause: err });
      }
    });
  },
};
