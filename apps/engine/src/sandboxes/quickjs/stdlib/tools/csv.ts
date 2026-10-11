import Papa from "papaparse";
import { bounded, MAX_ROWS, text } from "./limits.ts";

type Options = { delimiter?: string; header?: boolean; columns?: string[]; formulaSafe?: boolean };
function delimiter(value = ","): string {
  if (value.length !== 1 || /["\r\n\0]/.test(value)) throw new Error("Invalid CSV delimiter");
  return value;
}
export const csv = Object.freeze({
  parse(source: string, options: Options = {}) {
    const result = Papa.parse(text(source).replace(/^\uFEFF/, ""), {
      delimiter: delimiter(options.delimiter),
      header: options.header ?? false,
      skipEmptyLines: "greedy",
      preview: MAX_ROWS + 1,
    });
    if (result.data.length > MAX_ROWS) throw new Error("CSV row limit exceeded");
    if (result.errors.length)
      throw new Error(
        `CSV_INVALID: ${JSON.stringify(result.errors.map(({ code, row, message }) => ({ code, row, message })))}`,
      );
    bounded(result.data);
    return result.data;
  },
  stringify(rows: unknown[], options: Options = {}) {
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error("CSV row limit exceeded");
    bounded(rows);
    return text(
      Papa.unparse(rows, {
        delimiter: delimiter(options.delimiter),
        header: options.header ?? true,
        columns: options.columns,
        newline: "\r\n",
        escapeFormulae: options.formulaSafe ?? true,
      }),
    );
  },
});
