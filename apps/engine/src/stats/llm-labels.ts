import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversations } from "../db/schema/index.ts";
import { isUuid } from "../utils/index.ts";

interface ConversationLabel {
  title: string | null;
  owner_id: string | null;
  updated_at: string;
}

export async function readConversationLabels(
  db: Db,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, ConversationLabel>> {
  const wanted = [...new Set(ids.filter((id) => isUuid(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      owner_id: conversations.owner_id,
      updated_at: conversations.updated_at,
    })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenantId), inArray(conversations.id, wanted)));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        title: row.title?.trim() ? row.title.trim() : null,
        owner_id: row.owner_id,
        updated_at: new Date(row.updated_at).toISOString(),
      },
    ]),
  );
}
