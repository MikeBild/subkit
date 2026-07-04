// XLSX/XLS strategy — Excel sheets → `Record<sheetName, Array<row>>`.
//
// Uses SheetJS (`xlsx`). Each sheet's first non-empty row is treated as
// the header row; subsequent rows are emitted as objects keyed by those
// headers, capped at 200 rows per sheet to keep RawChunks bounded
// (mirrors the CSV row cap in `sources/file-upload.ts`).
//
// Hard 60 s timeout via `withParserTimeout`: pathological workbooks can
// trigger O(n²) blowups in SheetJS and we'd rather fail the request than
// starve the event loop. See `apps/engine/AGENTS.md` for the supply-chain
// note on the `xlsx` package version pinning.

import * as XLSX from "xlsx";
import {
  BinaryParseError,
  DetectionPriority,
  type FileParsingStrategy,
  PARSER_TIMEOUT_MS,
  withParserTimeout,
} from "./strategy.ts";
import { hasZipEntryPrefix } from "./zip-sniff.ts";

const XLS_OLE_SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
export const XLSX_ROW_CAP_PER_SHEET = 200;

export type XlsxFormat = "xlsx" | "xls";

export interface XlsxParseOutput {
  format: XlsxFormat;
  sheets: Record<string, Array<Record<string, unknown>>>;
}

function buildStrategy(format: XlsxFormat): FileParsingStrategy<XlsxParseOutput> {
  return {
    format,
    // `.xlsx` is an Office Open XML ZIP (detected via internal `xl/`
    // prefix); `.xls` is a legacy OLE2 compound binary (detected via
    // magic bytes). The two land in different priority bands so the
    // enum name accurately reflects the discriminator each strategy
    // uses.
    priority:
      format === "xlsx"
        ? DetectionPriority.ZIP_BASED_SPECIFIC
        : DetectionPriority.BINARY_SIGNATURE_LEGACY,

    canHandle(buffer: Buffer): boolean {
      if (format === "xlsx") return hasZipEntryPrefix(buffer, "xl/");
      // .xls (legacy OLE2 compound binary) — magic D0 CF 11 E0 A1 B1 1A E1.
      if (buffer.length < XLS_OLE_SIG.length) return false;
      return buffer.subarray(0, XLS_OLE_SIG.length).equals(XLS_OLE_SIG);
    },

    async parse(buffer: Buffer): Promise<XlsxParseOutput> {
      return withParserTimeout(format, PARSER_TIMEOUT_MS[format], async () => {
        try {
          const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
          const sheets: XlsxParseOutput["sheets"] = {};
          for (const name of wb.SheetNames) {
            const sheet = wb.Sheets[name];
            if (!sheet) continue;
            // Bound the row read at parse time. A 10M-row sheet would
            // otherwise allocate the full row array via sheet_to_json
            // BEFORE the slice() caps it — enough to OOM the worker
            // inside the 60s timeout window. We clamp the worksheet's
            // existing data range (`!ref`) to header + N rows and
            // pass the bounded Range object to sheet_to_json. The
            // trailing slice() guard remains as defence-in-depth in
            // case `!ref` is missing.
            const opts: XLSX.Sheet2JSONOpts = {
              defval: null,
              raw: true,
            };
            const ref = sheet["!ref"];
            if (ref) {
              const full = XLSX.utils.decode_range(ref);
              const clamped: XLSX.Range = {
                s: full.s,
                // +1 because the first row is typically the header and
                // doesn't count against XLSX_ROW_CAP_PER_SHEET — keeps
                // the parser's per-sheet output shape stable.
                e: { c: full.e.c, r: Math.min(full.e.r, full.s.r + XLSX_ROW_CAP_PER_SHEET) },
              };
              opts.range = clamped;
            }
            const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, opts);
            sheets[name] = rows.slice(0, XLSX_ROW_CAP_PER_SHEET);
          }
          return { format, sheets };
        } catch (err) {
          throw new BinaryParseError(format, `${format}: failed to parse workbook`, {
            cause: err,
          });
        }
      });
    },
  };
}

export const xlsxStrategy = buildStrategy("xlsx");
export const xlsStrategy = buildStrategy("xls");
