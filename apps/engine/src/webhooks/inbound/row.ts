import type { webhooksInbound } from "../../db/schema/index.ts";

export type InboundVerifierName = "standard" | "github" | "stripe" | "hmac";

export type InboundOrigin = "crud" | "trigger";

export interface InboundRow {
  id: string;
  tenant_id: string;
  slug: string;
  workflow_id: string;
  verifier: InboundVerifierName;
  active: boolean;
  origin: InboundOrigin;
  created_at: Date;
  updated_at: Date;
}

export function serialize(row: typeof webhooksInbound.$inferSelect): InboundRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    slug: row.slug,
    workflow_id: row.workflow_id,
    verifier: row.verifier as InboundVerifierName,
    active: row.active,
    origin: (row.origin as InboundOrigin | undefined) ?? "crud",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
