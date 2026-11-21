import { z } from "zod";
import { DeviceSubBoundarySchema } from "./boundary.ts";

export const FolderTargetSchema = z
  .object({
    folder_id: z.string().min(1).max(200),
    path: z.string().max(4096),
  })
  .strict();
export type FolderTarget = z.infer<typeof FolderTargetSchema>;

export const AbsoluteTargetSchema = z
  .object({
    absolute: z.string().min(1).max(4096),
  })
  .strict();
export type AbsoluteTarget = z.infer<typeof AbsoluteTargetSchema>;

export const FileTargetSchema = z.union([FolderTargetSchema, AbsoluteTargetSchema]);
export type FileTarget = z.infer<typeof FileTargetSchema>;

export const FILES_BATCH_MAX = 200;

const boundary = DeviceSubBoundarySchema.optional();

export const FilesListArgsSchema = z.object({ target: FileTargetSchema, boundary }).strict();
export const FilesReadTextArgsSchema = FilesListArgsSchema;
export const FilesImportArgsSchema = z
  .object({ target: FileTargetSchema, boundary, name: z.string().min(1).max(255).optional() })
  .strict();
export const FilesMkdirArgsSchema = FilesListArgsSchema;

export const FileContentSchema = z.discriminatedUnion("encoding", [
  z.object({ encoding: z.literal("utf8"), text: z.string() }).strict(),
  z.object({ encoding: z.literal("base64"), data: z.string() }).strict(),
]);
export type FileContent = z.infer<typeof FileContentSchema>;

export const FilesWriteArgsSchema = z
  .object({
    target: FileTargetSchema,
    boundary,
    content: FileContentSchema,
    replace: z.boolean().default(false),
  })
  .strict();

export const FilesMoveArgsSchema = z
  .object({
    items: z
      .array(z.object({ from: FileTargetSchema, to: FileTargetSchema }).strict())
      .min(1)
      .max(FILES_BATCH_MAX),
    boundary,
  })
  .strict();

export const FilesTrashArgsSchema = z
  .object({ items: z.array(FileTargetSchema).min(1).max(FILES_BATCH_MAX), boundary })
  .strict();

export const FILE_ITEM_STATUSES = ["done", "refused", "failed", "not_run"] as const;
export type FileItemStatus = (typeof FILE_ITEM_STATUSES)[number];

export interface FileItemResult {
  readonly index: number;
  readonly status: FileItemStatus;
  readonly code?: string;
  readonly version?: string;
}

export interface FileListEntry {
  readonly name: string;
  readonly kind: "file" | "folder" | "link" | "other";
  readonly size: number;
  readonly modified_at: string;
}

export interface WireAllowanceKey {
  readonly kind: string;
  readonly id: string;
}

export function allowancesDigestMaterial(allowances: readonly WireAllowanceKey[]): string {
  const sorted = [...allowances].sort((left, right) => {
    const a = `${left.kind}\u0000${left.id}`;
    const b = `${right.kind}\u0000${right.id}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return JSON.stringify(
    sorted.map((item) =>
      Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    ),
  );
}
