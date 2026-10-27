import { and, eq, inArray } from "drizzle-orm";
import { FileIdSchema } from "../api/files-schemas.ts";
import type { Db } from "../db/client.ts";
import { fileLinks } from "../db/schema/files.ts";

export async function executionDataFileIds(
  db: Db,
  tenantId: string,
  references: string[],
): Promise<Set<string>> {
  const ids = references.flatMap((reference) => {
    const parsed = FileIdSchema.safeParse(
      reference.startsWith("fid_") ? reference : `fid_${reference}`,
    );
    return parsed.success ? [parsed.data.slice(4)] : [];
  });
  if (!ids.length) return new Set();
  const rows = await db
    .select({ id: fileLinks.file_id })
    .from(fileLinks)
    .where(
      and(
        eq(fileLinks.tenant_id, tenantId),
        eq(fileLinks.role, "execution_data"),
        inArray(fileLinks.file_id, ids),
      ),
    );
  return new Set(rows.map((row) => row.id));
}
