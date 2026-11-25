import { CSV_DELIMITERS } from "@shared/files-constants.ts";
import { z } from "zod";

export const TABLE_FORMATS = ["csv", "xlsx"] as const;

export const TableParseOptionsSchema = z.object({
  format: z.enum(TABLE_FORMATS),
  max_rows: z.number().int().positive(),
  sheet: z.string().min(1).optional(),
  delimiter: z.enum(CSV_DELIMITERS).optional(),
});

export type TableParseOptions = z.infer<typeof TableParseOptionsSchema>;
