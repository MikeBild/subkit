import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { mcpOauthAuthorizationCodes } from "../../db/schema/index.ts";

export async function consumeRejectedAuthorizationCode(db: Db, codeId: string): Promise<void> {
  await db
    .update(mcpOauthAuthorizationCodes)
    .set({ consumed_at: sql`now()` })
    .where(
      and(
        eq(mcpOauthAuthorizationCodes.id, codeId),
        isNull(mcpOauthAuthorizationCodes.consumed_at),
      ),
    );
}
