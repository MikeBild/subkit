import type { Executor } from "../../db/client.ts";
import { listKnowledgeChunks } from "../../knowledge/bundle-service.ts";
import type { KnowledgeSourceView } from "../../knowledge/types.ts";

export const KNOWLEDGE_READ_MAX_BYTES = 1024 * 1024;

export async function renderKnowledgeResourceText(
  ks: KnowledgeSourceView,
  tenant_id: string,
  db: Executor,
): Promise<string> {
  const parts: string[] = [
    `<!-- knowledge source: ${ks.name} (id: ${ks.id}, scope: ${ks.scope}, source_type: ${ks.source_type}, chunks: ${ks.chunk_count}, bytes_total: ${ks.bytes_total}, status: ${ks.status}) -->`,
  ];
  let usedBytes = Buffer.byteLength(parts[0]!, "utf8");
  let truncated = false;
  let offset = 0;
  pages: while (true) {
    const page = await listKnowledgeChunks(
      { tenant_id, knowledge_source_id: ks.id, offset, limit: 200 },
      db,
    );
    if (!page || page.chunks.length === 0) break;
    for (const chunk of page.chunks) {
      const header = `<!-- ${chunk.path ?? chunk.title ?? `chunk ${chunk.ordinal}`} -->`;
      const bytes = Buffer.byteLength(header, "utf8") + chunk.byte_size + 4;
      if (usedBytes + bytes > KNOWLEDGE_READ_MAX_BYTES) {
        truncated = true;
        break pages;
      }
      parts.push(header, chunk.content);
      usedBytes += bytes;
    }
    if (page.chunks.length < 200) break;
    offset += page.chunks.length;
  }
  if (truncated) {
    parts.push(
      `<!-- truncated at ${KNOWLEDGE_READ_MAX_BYTES} bytes — use the read_knowledge tool (offset/path) for the remainder -->`,
    );
  }
  return parts.join("\n\n");
}
