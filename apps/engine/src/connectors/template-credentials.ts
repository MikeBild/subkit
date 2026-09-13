import { and, eq } from "drizzle-orm";

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import { type Executor, getDb } from "../db/client.ts";
import { connectorTemplateCredentials } from "../db/schema/index.ts";

function aadFor(tenant_id: string, template_slug: string): string {
  return `connector-template-credential:${tenant_id}:${template_slug}`;
}

function toBuf(value: Uint8Array): Buffer {
  return Buffer.from(value);
}

export interface ConnectorTemplateOAuthCredentialValue {
  client_id: string;
  client_secret: string;
}

export async function upsertTemplateOAuthCredentials(
  input: {
    tenant_id: string;
    template_slug: string;
    value: ConnectorTemplateOAuthCredentialValue;
    actor_id: string | null;
  },
  exec?: Executor,
): Promise<{ id: string }> {
  const db = exec ?? getDb();
  return await db.transaction(async (tx) => {
    const payload = encryptSecret(
      JSON.stringify(input.value),
      aadFor(input.tenant_id, input.template_slug),
    );
    const existing = await tx
      .select()
      .from(connectorTemplateCredentials)
      .where(
        and(
          eq(connectorTemplateCredentials.tenant_id, input.tenant_id),
          eq(connectorTemplateCredentials.template_slug, input.template_slug),
        ),
      )
      .limit(1);
    const prior = existing[0];
    const [row] = prior
      ? await tx
          .update(connectorTemplateCredentials)
          .set({
            ciphertext: toBuf(payload.ciphertext),
            iv: toBuf(payload.iv),
            auth_tag: toBuf(payload.auth_tag),
            updated_at: new Date(),
          })
          .where(eq(connectorTemplateCredentials.id, prior.id))
          .returning()
      : await tx
          .insert(connectorTemplateCredentials)
          .values({
            tenant_id: input.tenant_id,
            template_slug: input.template_slug,
            ciphertext: toBuf(payload.ciphertext),
            iv: toBuf(payload.iv),
            auth_tag: toBuf(payload.auth_tag),
          })
          .returning();
    if (!row) throw new Error("connector template credential upsert returned no row");
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: prior ? AuditAction.CREDENTIAL_UPDATED : AuditAction.CREDENTIAL_CREATED,
        resource_type: "connector_template_credential",
        resource_id: row.id,
        result: "success",
        metadata: { template_slug: input.template_slug },
      },
      tx,
    );
    return { id: row.id };
  });
}

export async function getTemplateOAuthCredentials(
  tenant_id: string,
  template_slug: string,
  exec?: Executor,
): Promise<ConnectorTemplateOAuthCredentialValue | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(connectorTemplateCredentials)
    .where(
      and(
        eq(connectorTemplateCredentials.tenant_id, tenant_id),
        eq(connectorTemplateCredentials.template_slug, template_slug),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const raw = decryptSecret(
    {
      ciphertext: row.ciphertext,
      iv: row.iv,
      auth_tag: row.auth_tag,
    },
    aadFor(tenant_id, template_slug),
  );
  const parsed = JSON.parse(raw) as Partial<ConnectorTemplateOAuthCredentialValue>;
  if (typeof parsed.client_id !== "string" || typeof parsed.client_secret !== "string") {
    throw new Error(`connector template credential ${template_slug} is malformed`);
  }
  return {
    client_id: parsed.client_id,
    client_secret: parsed.client_secret,
  };
}
