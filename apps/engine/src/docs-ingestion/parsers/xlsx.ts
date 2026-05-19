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
export const XLSX_PARSE_TIMEOUT_MS = PARSER_TIMEOUT_MS.xlsx;
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
            const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
              defval: null,
              raw: true,
            });
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
