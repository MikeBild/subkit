import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { runtimeSecretVersions } from "../db/schema/index.ts";

export async function insertRuntimeSecretVersion(
  tx: Executor,
  input: {
    name: string;
    version: number;
    ciphertext: Uint8Array;
    iv: Uint8Array;
    auth_tag: Uint8Array;
    created_by: string | null;
    pending: { prepared_by: string; bindings: string[] } | null;
  },
): Promise<{ created_at: Date }> {
  const values = sql`${input.name},${input.version},${Buffer.from(input.ciphertext)},${Buffer.from(input.iv)},${Buffer.from(input.auth_tag)},${input.created_by}`;
  const pending = input.pending;
  const inserted = await tx.execute<{ created_at: Date | string }>(
    sql`INSERT INTO ${runtimeSecretVersions}(name,version,ciphertext,iv,auth_tag,created_by,pending_since,prepared_by,pending_bindings) VALUES(${values},${pending ? new Date() : null},${pending?.prepared_by ?? null},${pending ? JSON.stringify(pending.bindings) : null}::jsonb) RETURNING created_at`,
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("runtime secret insert returned no row");
  return { created_at: new Date(row.created_at) };
}
