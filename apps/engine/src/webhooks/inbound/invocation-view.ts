import { and, eq } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { webhooksInbound } from "../../db/schema/index.ts";
import { HmacVerifierConfig } from "./verifiers/hmac.ts";

const SIGNING_HEADERS: Record<string, readonly string[]> = {
  standard: ["webhook-id", "webhook-timestamp", "webhook-signature"],
  github: ["x-hub-signature-256", "x-github-delivery", "x-github-event"],
  stripe: ["stripe-signature"],
};

interface InboundHookSigning {
  signed: boolean;
  headers: string[];
  hmac: {
    algorithm: "sha256";
    encoding: "hex" | "base64";
    signed_payload: string;
    signature_prefix: string;
    id_field?: string;
  } | null;
}

export function describeInboundSigning(
  verifier: string,
  config: Record<string, unknown> | null,
): InboundHookSigning {
  if (config?.skip === true) return { signed: false, headers: [], hmac: null };
  if (verifier === "hmac") {
    const parsed = HmacVerifierConfig.safeParse(config?.hmac);
    if (!parsed.success) return { signed: true, headers: [], hmac: null };
    const scheme = parsed.data;
    return {
      signed: true,
      headers: [
        scheme.signature_header,
        ...(scheme.id_header ? [scheme.id_header] : []),
        ...(scheme.timestamp_header ? [scheme.timestamp_header] : []),
        ...(scheme.type_header ? [scheme.type_header] : []),
      ],
      hmac: {
        algorithm: scheme.algorithm,
        encoding: scheme.encoding,
        signed_payload: scheme.signed_payload,
        signature_prefix: scheme.signature_prefix,
        ...(scheme.id_field ? { id_field: scheme.id_field } : {}),
      },
    };
  }
  return { signed: true, headers: [...(SIGNING_HEADERS[verifier] ?? [])], hmac: null };
}

interface WorkflowInboundHookView extends InboundHookSigning {
  slug: string;
  verifier: string;
  state: "active" | "inactive" | "held";
}

export async function listWorkflowInboundHooks(
  tenant_id: string,
  workflow_id: string,
  db: Executor,
): Promise<WorkflowInboundHookView[]> {
  const rows = await db
    .select({
      slug: webhooksInbound.slug,
      verifier: webhooksInbound.verifier,
      native_verifier_config: webhooksInbound.native_verifier_config,
      active: webhooksInbound.active,
      admission_hold: webhooksInbound.admission_hold,
    })
    .from(webhooksInbound)
    .where(
      and(eq(webhooksInbound.tenant_id, tenant_id), eq(webhooksInbound.workflow_id, workflow_id)),
    )
    .orderBy(webhooksInbound.slug);
  return rows.map((row) => ({
    slug: row.slug,
    verifier: row.verifier,
    state: !row.active ? "inactive" : row.admission_hold ? "held" : "active",
    ...describeInboundSigning(
      row.verifier,
      (row.native_verifier_config as Record<string, unknown> | null) ?? null,
    ),
  }));
}
