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
const XLSX_ROW_CAP_PER_SHEET = 200;

export type XlsxFormat = "xlsx" | "xls";

export interface XlsxParseOutput {
  format: XlsxFormat;
  sheets: Record<string, Array<Record<string, unknown>>>;
}

function buildStrategy(format: XlsxFormat): FileParsingStrategy<XlsxParseOutput> {
  return {
    format,
    priority:
      format === "xlsx"
        ? DetectionPriority.ZIP_BASED_SPECIFIC
        : DetectionPriority.BINARY_SIGNATURE_LEGACY,

    canHandle(buffer: Buffer): boolean {
      if (format === "xlsx") return hasZipEntryPrefix(buffer, "xl/");
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
            const opts: XLSX.Sheet2JSONOpts = {
              defval: null,
              raw: true,
            };
            const ref = sheet["!ref"];
            if (ref) {
              const full = XLSX.utils.decode_range(ref);
              const clamped: XLSX.Range = {
                s: full.s,
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
