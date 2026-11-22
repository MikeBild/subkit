import { escapeMarkdownTableCell } from "@shared/markdown-escape.ts";
import type { PDFParse } from "pdf-parse";
import {
  BinaryParseError,
  DetectionPriority,
  type FileParsingStrategy,
  PARSER_TIMEOUT_MS,
  withParserTimeout,
} from "./strategy.ts";

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]);
export const PDF_PAGE_SEPARATOR = "\n\n---\n\n";

export interface PdfPageTables {
  page: number;
  tables: string[][][];
}

export interface PdfParseOutput {
  format: "pdf";
  text: string;
  pages: number;
  tables: PdfPageTables[];
}

function tableToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return "";
  const header = rows[0] ?? [];
  const lines = [
    `| ${header.map(escapeMarkdownTableCell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((r) => `| ${r.map(escapeMarkdownTableCell).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function ensurePdfjsGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix !== "undefined") return;
  class DOMMatrixShim {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    is2D = true;
    isIdentity = true;
    constructor(init?: number[]) {
      if (Array.isArray(init) && init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init as [
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        this.isIdentity =
          this.a === 1 &&
          this.b === 0 &&
          this.c === 0 &&
          this.d === 1 &&
          this.e === 0 &&
          this.f === 0;
      }
    }
    scale(): DOMMatrixShim {
      return this;
    }
    translate(): DOMMatrixShim {
      return this;
    }
    multiply(): DOMMatrixShim {
      return this;
    }
    inverse(): DOMMatrixShim {
      return this;
    }
    transformPoint(p: unknown): unknown {
      return p;
    }
  }
  g.DOMMatrix = DOMMatrixShim;
}

async function ensurePdfjsWorker(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  if (g.pdfjsWorker) return;
  try {
    g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  } catch {}
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
      ensurePdfjsGlobals();
      await ensurePdfjsWorker();
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
        let tablePages: PdfPageTables[] = [];
        try {
          const tableResult = await parser.getTable();
          tablePages = tableResult.pages
            .filter((p) => p.tables.length > 0)
            .map((p) => ({ page: p.num, tables: p.tables }));
        } catch {
          tablePages = [];
        }
        const tablesByPage = new Map(tablePages.map((p) => [p.page, p.tables]));
        const text = result.pages
          .map((p) => {
            const pageTables = tablesByPage.get(p.num) ?? [];
            if (pageTables.length === 0) return p.text;
            const rendered = pageTables
              .map(tableToMarkdown)
              .filter((t) => t.length > 0)
              .join("\n\n");
            return rendered.length > 0 ? `${p.text}\n\n${rendered}` : p.text;
          })
          .join(PDF_PAGE_SEPARATOR);
        return { format: "pdf", text, pages: result.pages.length, tables: tablePages };
      } catch (err) {
        throw new BinaryParseError("pdf", "pdf: failed to extract text", { cause: err });
      } finally {
        try {
          await parser.destroy();
        } catch {}
      }
    });
  },
};
