import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { FileIdSchema } from "../../api/files-schemas.ts";
import { fileLinks, files } from "../../db/schema/files.ts";
import { type ResolvedFile, resolvedFromRow } from "../../files/resolver.ts";
import type { ToolContext } from "./index.ts";

export const WorkflowInputFileSchema = z
  .object({
    id: FileIdSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const MAX_INPUT_BYTES = 1_048_576;
const InputObject = z.record(z.string(), z.unknown());

export async function decodeWorkflowInputFile(
  file: ResolvedFile,
  expectedHash: string,
): Promise<Record<string, unknown>> {
  if (file.size_bytes < 2 || file.size_bytes > MAX_INPUT_BYTES)
    throw new Error("Workflow input file exceeds the supported size");
  const bytes = new Uint8Array(file.size_bytes);
  let offset = 0;
  for await (const chunk of await file.openRead()) {
    if (offset + chunk.byteLength > bytes.byteLength)
      throw new Error("Workflow input file size changed");
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (
    offset !== bytes.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== expectedHash
  )
    throw new Error("Workflow input file content changed");
  return InputObject.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

export async function loadWorkflowInputFile(
  ctx: Pick<ToolContext, "db" | "tenant_id" | "conversation_id">,
  source: z.infer<typeof WorkflowInputFileSchema>,
): Promise<Record<string, unknown>> {
  const [row] = await ctx.db
    .select({ file: files })
    .from(fileLinks)
    .innerJoin(files, and(eq(files.id, fileLinks.file_id), eq(files.tenant_id, ctx.tenant_id)))
    .where(
      and(
        eq(fileLinks.tenant_id, ctx.tenant_id),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, ctx.conversation_id),
        eq(fileLinks.file_id, source.id.slice(4)),
        eq(files.status, "ready"),
        isNull(files.deleted_at),
        eq(files.sha256, source.sha256),
      ),
    )
    .limit(1);
  if (!row) throw new Error("Workflow input file is not available in this conversation");
  return decodeWorkflowInputFile(resolvedFromRow(row.file), source.sha256);
}
