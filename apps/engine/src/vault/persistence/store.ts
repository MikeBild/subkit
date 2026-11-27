import { isStructuredKind } from "@shared/vault-kinds.ts";
import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Actor, AuditActionValue } from "../../audit/index.ts";
import { auditActor, auditAwait } from "../../audit/index.ts";
import { deserializePlain } from "../../credentials/index.ts";
import {
  decryptSecret,
  encryptSecret,
  sha256HexOfBytes,
  vaultItemAadCandidates,
  vaultItemAadV1,
  vaultItemAadV2,
} from "../../crypto/index.ts";
import type { Executor, ScopedTx } from "../../db/index.ts";
import { connectors, vaultItems } from "../../db/index.ts";
import { metadataOf, plainOf } from "../core/kinds.ts";
import {
  isEditableKind,
  VAULT_PERMISSION,
  type VaultEnvironment,
  type VaultItemKind,
  type VaultValue,
  type VaultViewer,
  vaultScopeOf,
} from "../core/vault-item.ts";

export class VaultError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "forbidden"
      | "conflict"
      | "invalid"
      | "unreadable"
      | "reauth_required",
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export const COLUMNS = {
  id: vaultItems.id,
  tenant_id: vaultItems.tenant_id,
  name: vaultItems.name,
  kind: vaultItems.kind,
  owner_user_id: vaultItems.owner_user_id,
  environment: vaultItems.environment,
  mode: vaultItems.mode,
  description: vaultItems.description,
  credential_generation: vaultItems.credential_generation,
  template_slug: vaultItems.template_slug,
  connector_id: vaultItems.connector_id,
  connector_slug: connectors.slug,
  connector_display_name: connectors.display_name,
  fields: vaultItems.fields,
  origins: vaultItems.origins,
  value_digest: vaultItems.value_digest,
  created_at: vaultItems.created_at,
  updated_at: vaultItems.updated_at,
  rotated_at: vaultItems.rotated_at,
  last_used_at: vaultItems.last_used_at,
};

export type ItemRow = {
  id: string;
  tenant_id: string;
  name: string;
  kind: VaultItemKind;
  owner_user_id: string | null;
  environment: VaultEnvironment;
  mode: string;
  description: string | null;
  credential_generation: number;
  template_slug: string | null;
  connector_id: string | null;
  connector_slug: string | null;
  connector_display_name: string | null;
  fields: Record<string, unknown>;
  origins: string[];
  value_digest: string | null;
  created_at: Date;
  updated_at: Date;
  rotated_at: Date | null;
  last_used_at: Date | null;
};

export function visibleTo(viewer: VaultViewer) {
  const own = viewer.user_id ? eq(vaultItems.owner_user_id, viewer.user_id) : sql`false`;
  return viewer.permissions.has(VAULT_PERMISSION.read)
    ? or(isNull(vaultItems.owner_user_id), own)
    : own;
}

export function selectItems(db: ScopedTx, tenant_id: string, ...conditions: (SQL | undefined)[]) {
  return db
    .select(COLUMNS)
    .from(vaultItems)
    .leftJoin(connectors, eq(connectors.id, vaultItems.connector_id))
    .where(and(eq(vaultItems.tenant_id, tenant_id), ...conditions));
}

function templateAadFor(tenant_id: string, template_slug: string): string {
  return `connector-template-credential:${tenant_id}:${template_slug}`;
}

export function modeOf(kind: VaultValue["kind"]): "bearer" | "basic" | "structured" {
  if (kind === "secret") return "bearer";
  if (kind === "login") return "basic";
  return "structured";
}

export interface SealedValue {
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  value_digest: string;
  fields: Record<string, unknown>;
}

export function sealed(
  subject: { tenant_id: string; id: string; owner_user_id: string | null },
  value: VaultValue,
): SealedValue {
  const payload = encryptSecret(
    JSON.stringify(plainOf(value)),
    vaultItemAadV2({ ...subject, kind: value.kind }),
  );
  const ciphertext = Buffer.from(payload.ciphertext);
  return {
    ciphertext,
    iv: Buffer.from(payload.iv),
    auth_tag: Buffer.from(payload.auth_tag),
    value_digest: sha256HexOfBytes(ciphertext),
    fields: { ...metadataOf(value) },
  };
}

function aadsFor(row: ItemRow): readonly string[] {
  if (row.kind === "template_client" && row.template_slug) {
    return [templateAadFor(row.tenant_id, row.template_slug)];
  }
  if (!isEditableKind(row.kind)) return [vaultItemAadV1(row.tenant_id, row.id)];
  return vaultItemAadCandidates(row);
}

export interface OpenedRow {
  readonly plain: string;
  readonly value_digest: string;
}

export async function openSealedRow(db: ScopedTx, row: ItemRow, lock = false): Promise<OpenedRow> {
  const query = db
    .select({ ciphertext: vaultItems.ciphertext, iv: vaultItems.iv, auth_tag: vaultItems.auth_tag })
    .from(vaultItems)
    .where(and(eq(vaultItems.tenant_id, row.tenant_id), eq(vaultItems.id, row.id)))
    .limit(1);
  const [sealedRow] = await (lock ? query.for("update") : query);
  if (!sealedRow) throw new VaultError("not_found", "vault item not found");
  const failures: unknown[] = [];
  for (const aad of aadsFor(row)) {
    try {
      return {
        plain: decryptSecret(sealedRow, aad),
        value_digest: sha256HexOfBytes(Buffer.from(sealedRow.ciphertext)),
      };
    } catch (error) {
      failures.push(error);
    }
  }
  throw new VaultError(
    "unreadable",
    `this vault item can't be opened with the current key (${failures.length} attempts)`,
  );
}

export async function openRow(db: ScopedTx, row: ItemRow, lock = false): Promise<string> {
  return (await openSealedRow(db, row, lock)).plain;
}

export function storedValueOf(kind: VaultItemKind, raw: string, mode: string): VaultValue | null {
  if (!isEditableKind(kind)) return null;
  const decoded = (
    mode === "structured" || kind === "login" || kind === "secret"
      ? JSON.parse(raw)
      : deserializePlain(mode as never, raw)
  ) as Record<string, unknown>;
  if (kind === "secret") {
    return typeof decoded.token === "string" ? { kind, token: decoded.token } : null;
  }
  if (kind === "login") {
    if (typeof decoded.username !== "string" || typeof decoded.password !== "string") return null;
    return {
      kind,
      username: decoded.username,
      password: decoded.password,
      ...(typeof decoded.totp_seed === "string" ? { totp_seed: decoded.totp_seed } : {}),
    };
  }
  if (!isStructuredKind(kind)) return null;
  return { ...decoded, kind } as VaultValue;
}

export function revealedFields(row: ItemRow, raw: string): Record<string, string> {
  const decoded: Record<string, unknown> =
    row.kind === "template_client" || isEditableKind(row.kind)
      ? (JSON.parse(raw) as Record<string, unknown>)
      : (deserializePlain(row.mode as never, raw) as unknown as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(decoded)) {
    if (key === "mode") continue;
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number") out[key] = String(value);
    else if (value && typeof value === "object") out[key] = JSON.stringify(value);
  }
  return out;
}

export async function record(
  db: Executor,
  tenant_id: string,
  actor: Actor | null,
  action: AuditActionValue,
  row: { id: string; name: string; kind: string; owner_user_id: string | null },
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await auditAwait(
    {
      tenant_id,
      ...auditActor(actor),
      action,
      resource_type: "vault_item",
      resource_id: row.id,
      result: "success",
      metadata: {
        name: row.name,
        kind: row.kind,
        scope: vaultScopeOf(row),
        ...metadata,
      },
    },
    db,
  );
}
