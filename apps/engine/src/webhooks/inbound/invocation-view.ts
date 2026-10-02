// How to call a workflow's inbound hooks — the facts a sender needs, and
// nothing a sender must not learn.
//
// A hook's signing secret is the only thing that authenticates a delivery, so
// this read never touches it: the columns are named one by one, and the three
// `secret_*` columns are not among them. What it returns is the public half of
// the contract — where to post, which headers carry the signature, and whether
// deliveries are currently admitted.

import { and, eq } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { webhooksInbound } from "../../db/schema/index.ts";
import { HmacVerifierConfig } from "./verifiers/hmac.ts";

/** The header names each fixed scheme reads; see the verifier of the same name. */
const SIGNING_HEADERS: Record<string, readonly string[]> = {
  standard: ["webhook-id", "webhook-timestamp", "webhook-signature"],
  github: ["x-hub-signature-256", "x-github-delivery", "x-github-event"],
  stripe: ["stripe-signature"],
};

export interface InboundHookSigning {
  /** False when the binding accepts unsigned deliveries. */
  signed: boolean;
  /** Header names a signed delivery must carry, lower-case. */
  headers: string[];
  /** The sender's scheme for a generic `hmac` binding; null for the fixed ones. */
  hmac: {
    algorithm: "sha256";
    encoding: "hex" | "base64";
    signed_payload: string;
    signature_prefix: string;
  } | null;
}

/**
 * What a delivery has to carry for this binding's verifier. A generic `hmac`
 * binding names its own headers in `native_verifier_config.hmac`; a config
 * that does not parse yields no header names rather than invented ones.
 */
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
        scheme.id_header,
        ...(scheme.timestamp_header ? [scheme.timestamp_header] : []),
        ...(scheme.type_header ? [scheme.type_header] : []),
      ],
      hmac: {
        algorithm: scheme.algorithm,
        encoding: scheme.encoding,
        signed_payload: scheme.signed_payload,
        signature_prefix: scheme.signature_prefix,
      },
    };
  }
  return { signed: true, headers: [...(SIGNING_HEADERS[verifier] ?? [])], hmac: null };
}

export interface WorkflowInboundHookView extends InboundHookSigning {
  slug: string;
  verifier: string;
  /**
   * `inactive` receives nothing; `held` is active but the authority gate
   * refused its last delivery; `active` admits deliveries.
   */
  state: "active" | "inactive" | "held";
}

/** A workflow's hooks as a sender needs them, by slug. Never reads a secret. */
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
