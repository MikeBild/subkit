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

/** Tables extracted per page, as row matrices (`rows[cols]` of cell
 *  text). Mirrors `pdf-parse`'s `TableResult.pages[n].tables` shape. */
export interface PdfPageTables {
  page: number;
  tables: string[][][];
}

export interface PdfParseOutput {
  format: "pdf";
  /** Per-page text joined by `PDF_PAGE_SEPARATOR`. Pages with extracted
   *  tables carry them appended as GitHub-markdown tables, so every
   *  text consumer (knowledge chunking, LLM text_extract, extract
   *  route) sees table structure without branching. */
  text: string;
  pages: number;
  /** Structured table data for consumers that want more than the
   *  rendered markdown. Empty when the document has no detectable
   *  tables or table extraction failed (extraction is additive — its
   *  failure never fails the text parse). */
  tables: PdfPageTables[];
}

/** Render one extracted table as a GitHub-markdown table. The first
 *  row is treated as the header (pdf-parse emits tables row-major with
 *  the visual header first). Pipes in cells are escaped; newlines
 *  collapse to spaces so one cell can't break the row grid. */
function tableToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cell = (v: string): string => v.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const header = rows[0] ?? [];
  const lines = [
    `| ${header.map(cell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((r) => `| ${r.map(cell).join(" | ")} |`),
  ];
  return lines.join("\n");
}

/** pdfjs-dist (transitive under `pdf-parse`) references `DOMMatrix` at
 *  module-evaluation time (`SCALE_MATRIX = new DOMMatrix()`). In dev the
 *  `@napi-rs/canvas` native provides it; inside a `bun build --compile`
 *  binary that native is absent, pdfjs's own polyfill attempt fails
 *  silently, and the module eval throws `DOMMatrix is not defined` —
 *  which killed EVERY pdf parse on the deployed engine. Text + table
 *  extraction never perform real matrix math or rasterisation, so a
 *  minimal identity-matrix shim satisfies module load; the rendering
 *  paths that would need a real implementation (`getImage`,
 *  `getScreenshot`) are never called here. Installed only when the
 *  global is absent, so environments with the real canvas polyfill are
 *  untouched. */
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

/** pdf.js resolves its worker by dynamically importing
 *  `GlobalWorkerOptions.workerSrc` — a RELATIVE './pdf.worker.mjs' path
 *  that cannot resolve inside a `bun build --compile` binary ("Cannot
 *  find module './pdf.worker.mjs' from '/$bunfs/root/engine'"). Its
 *  fake-worker setup checks `globalThis.pdfjsWorker` FIRST, so
 *  pre-loading the worker module through a static specifier (which the
 *  bundler embeds) short-circuits the broken path lookup entirely.
 *  Best-effort: in dev the on-disk resolution works without this. */
async function ensurePdfjsWorker(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  if (g.pdfjsWorker) return;
  try {
    g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  } catch {
    // Dev/test environments resolve the worker from node_modules via
    // pdf.js's own lookup; only the compiled binary needs the pre-load.
  }
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
        // Table extraction is additive enrichment: text is the
        // contract, tables improve it. A failure here (exotic layout,
        // parser bug) degrades to text-only — never throws.
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
        } catch {
          // destroy errors are not actionable here.
        }
      }
    });
  },
};
