import { and, eq } from "drizzle-orm";
import { type Actor, auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { decryptSecret, encryptSecret } from "../crypto/index.ts";
import type { Executor } from "../db/client.ts";
import { vaultItems } from "../db/schema/index.ts";
import { templateClientItemName } from "../vault/index.ts";

function aadFor(tenant_id: string, template_slug: string): string {
  return `connector-template-credential:${tenant_id}:${template_slug}`;
}

function toBuf(value: Uint8Array): Buffer {
  return Buffer.from(value);
}

interface ConnectorTemplateOAuthCredentialValue {
  client_id: string;
  client_secret: string;
}

export async function upsertTemplateOAuthCredentials(
  input: {
    tenant_id: string;
    template_slug: string;
    value: ConnectorTemplateOAuthCredentialValue;
    actor_id: string | null;
    actor?: Actor | null;
    actor_type?: AuditActorType;
  },
  db: Executor,
): Promise<{ id: string }> {
  return await db.transaction(async (tx) => {
    const payload = encryptSecret(
      JSON.stringify(input.value),
      aadFor(input.tenant_id, input.template_slug),
    );
    const existing = await tx
      .select()
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.tenant_id, input.tenant_id),
          eq(vaultItems.kind, "template_client"),
          eq(vaultItems.template_slug, input.template_slug),
        ),
      )
      .limit(1);
    const prior = existing[0];
    const [row] = prior
      ? await tx
          .update(vaultItems)
          .set({
            ciphertext: toBuf(payload.ciphertext),
            iv: toBuf(payload.iv),
            auth_tag: toBuf(payload.auth_tag),
            credential_generation: prior.credential_generation + 1,
            rotated_at: new Date(),
            updated_at: new Date(),
          })
          .where(eq(vaultItems.id, prior.id))
          .returning()
      : await tx
          .insert(vaultItems)
          .values({
            tenant_id: input.tenant_id,
            kind: "template_client",
            name: templateClientItemName(input.template_slug),
            template_slug: input.template_slug,
            environment: "prod",
            mode: "oauth2_client",
            created_by: input.actor_id,
            ciphertext: toBuf(payload.ciphertext),
            iv: toBuf(payload.iv),
            auth_tag: toBuf(payload.auth_tag),
          })
          .returning();
    if (!row) throw new Error("connector template credential upsert returned no row");
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        ...(input.actor !== undefined
          ? auditActor(input.actor)
          : input.actor_type === "unknown"
            ? { actor_type: "unknown" as const, actor_id: null }
            : input.actor_type
              ? { actor_type: input.actor_type, actor_id: input.actor_id }
              : input.actor_id
                ? { actor_type: "unknown" as const, actor_id: null }
                : auditActor(null)),
        action: prior ? AuditAction.VAULT_ITEM_UPDATED : AuditAction.VAULT_ITEM_CREATED,
        resource_type: "vault_item",
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
  db: Executor,
): Promise<ConnectorTemplateOAuthCredentialValue | null> {
  const rows = await db
    .select()
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.tenant_id, tenant_id),
        eq(vaultItems.kind, "template_client"),
        eq(vaultItems.template_slug, template_slug),
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
