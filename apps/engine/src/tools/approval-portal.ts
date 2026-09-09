// The approval portal — the out-of-band channel a HUMAN uses to grant or
// decline a tool approval.
//
// WHY IT EXISTS. Production said, across the full journal retention: 29
// `mcp.elicit.fallback` timeouts and not one fulfilled in-band elicitation in
// the old inline transport. Standalone tool calls therefore keep this durable
// browser channel. Conversation tasks now reattach persisted prompts to a live
// poll session and can prove `human/in_band_elicitation` provenance; they do
// not use this portal when that native channel is available.
//
// TOKEN DISCIPLINE — the same primitive `connectors/credential-setup-grant.ts`
// uses, deliberately not a second one:
//   - 24 random bytes → url-safe base64, `skag_` prefix ("sk Approval Grant")
//     so logs and prose can recognize it.
//   - SHA-256 hex at rest; the plaintext is returned once, at mint time, and
//     never persisted, logged, or audited.
//   - Bound to exactly one approval: the hash lives in that approval's own row.
//
// WHY THE HASH IS A COLUMN ON `tool_approvals` AND NOT A SECOND TABLE. A
// credential-setup grant outlives nothing — its connector is long-lived, so its
// lifetime needs its own `expires_at`. An approval's portal link has exactly the
// approval's lifetime. Putting the hash on the row makes "an expired approval
// must not have a live portal link" structural rather than a second clock that
// can drift, and the retention sweep that deletes the ciphertext deletes the
// token with it.
//
// SINGLE-USE. The token authenticates; it does not decide. The decision is one
// atomic CAS in `grantApproval` / `declineApproval` (`granted_at IS NULL AND
// declined_at IS NULL AND consumed_at IS NULL AND expires_at > now()`). Two
// portal tabs racing decide once. A token replayed after its decision can
// produce no second decision — it is dead as a capability — and the page it
// renders then withholds the preview and shows only the outcome.
//
// THE PREVIEW. `would_write` is the best "what will happen" payload the engine
// has: the exact requests a held-writes run resolved and did not dispatch. A
// human cannot approve what they cannot see, so it is persisted with the
// approval. It is encrypted, under an AAD distinct from the args' — a resolved
// URL can carry a query-mode credential, and a `jsonb` column would put that
// secret at rest in the clear. Ciphertext at rest is neither a log line nor
// prose, so `SECRET_PATTERNS` redaction does not apply to it; it applies at
// RENDER time, in the route, before the URL reaches a browser.

import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import type { Db, Executor } from "../db/client.ts";
import { toolApprovals } from "../db/schema/index.ts";
import { sha256Hex } from "../identity/api-key.ts";
// The mint runs inside an MCP tool call or a queue job — there is no HTTP
// request whose Host header could be trusted. `engineUrlFromConfig` reads
// `server.public_base_url`, which is the authoritative answer for exactly that
// case, and is a DNS hostname rather than a raw address.
import { engineUrlFromConfig } from "../llm/runtime-context.ts";
import { logger } from "../logging/logger.ts";
import {
  type PreparedWorkflowBinding,
  PreparedWorkflowBindingSchema,
} from "./prepared-workflow-approval.ts";

/** Browser-facing decision page. One route, no approval id in the URL: the
 *  token identifies the approval, and the id is a value the MODEL already
 *  holds — putting it in the address bar would invite pasting it back. */
export const APPROVAL_PORTAL_PATH = "/v1/tool-approvals/decide";

/** Distinct from `sksg_` (credential setup) and `skog_` (OAuth start): a leaked
 *  grant of one kind must not be redeemable at another kind's route, and the
 *  prefix is what makes that legible in a log line. */
export const APPROVAL_GRANT_PREFIX = "skag_";

/** The `wf_<slug>` names the MCP catalog and the chat palette mint for a
 *  workflow. `tools/` sits underneath both, so the literal lives here rather
 *  than being imported upward out of one of them. */
const WORKFLOW_TOOL_PREFIX = "wf_";

export interface IssuedApprovalGrant {
  readonly plaintext: string;
  readonly hash: string;
}

/** Generate a fresh opaque approval-grant token. Hash is SHA-256 hex. */
export function generateApprovalGrant(): IssuedApprovalGrant {
  const rand = randomBytes(24).toString("base64url");
  const plaintext = `${APPROVAL_GRANT_PREFIX}${rand}`;
  return { plaintext, hash: sha256Hex(plaintext) };
}

/** Hash a candidate grant token, or reject it before it reaches Postgres. A
 *  string that cannot be a grant is not worth a query. */
function parseApprovalGrant(token: string): string | null {
  if (!token.startsWith(APPROVAL_GRANT_PREFIX)) return null;
  if (token.length < APPROVAL_GRANT_PREFIX.length + 20) return null;
  return sha256Hex(token);
}

/** One external write a held-writes preview resolved but did not dispatch. */
export interface ApprovalWouldWrite {
  readonly step: string;
  readonly method: string | null;
  readonly url: string | null;
}

/** What the engine can honestly tell a human will happen if they approve. */
export interface ApprovalPreview {
  readonly would_write: readonly ApprovalWouldWrite[];
  readonly prepared_workflow?: PreparedWorkflowBinding;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Narrow the `would_write` details a held-writes warning carries. Entries
 *  without a `step` name nothing and are dropped rather than rendered blank. */
export function normalizeWouldWrite(value: unknown): ApprovalWouldWrite[] {
  if (!Array.isArray(value)) return [];
  const out: ApprovalWouldWrite[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const step = asStringOrNull(rec.step);
    if (step === null) continue;
    out.push({ step, method: asStringOrNull(rec.method), url: asStringOrNull(rec.url) });
  }
  return out;
}

/** Build the preview to persist, or null when the gate has nothing to show —
 *  a `create_api_key` confirm holds no writes and previews none. */
export function buildApprovalPreview(
  details: { readonly would_write?: unknown } | undefined,
): ApprovalPreview | null {
  const would_write = normalizeWouldWrite(details?.would_write);
  return would_write.length > 0 ? { would_write } : null;
}

/** Distinct from the args AAD (`tenant_id:approval_id`), so a preview
 *  ciphertext can never be lifted into `args_ciphertext` and replayed as the
 *  call's arguments. */
function previewAad(tenant_id: string, approval_id: string): string {
  return `${tenant_id}:${approval_id}:preview`;
}

export interface EncryptedApprovalPreview {
  readonly preview_ciphertext: Uint8Array;
  readonly preview_iv: Uint8Array;
  readonly preview_auth_tag: Uint8Array;
}

/** Encrypt the preview for `tool_approvals`. Called by `requestApproval` in the
 *  same transaction as the row insert. */
export function encryptApprovalPreview(
  tenant_id: string,
  approval_id: string,
  preview: ApprovalPreview,
): EncryptedApprovalPreview {
  const enc = encryptSecret(JSON.stringify(preview), previewAad(tenant_id, approval_id));
  return {
    preview_ciphertext: enc.ciphertext,
    preview_iv: enc.iv,
    preview_auth_tag: enc.auth_tag,
  };
}

export type MintApprovalGrantUrlError = {
  readonly ok: false;
  readonly error: "engine_public_url_missing" | "approval_not_pending";
};

export interface MintedApprovalGrantUrl {
  readonly ok: true;
  readonly url: string;
  readonly expires_at: Date;
}

export interface MintApprovalGrantUrlInput {
  /** The transaction that inserted the approval, or a plain `Db`. */
  readonly db: Executor;
  readonly approval: { readonly id: string; readonly tenant_id: string };
}

/**
 * Mint the one-shot, expiring, tenant-scoped URL a human opens to decide on
 * `approval.id`.
 *
 * Tenant-scoped and pending-scoped in one CAS: an approval already granted,
 * already declined, already spent, or past `expires_at` gets no link — an
 * expired approval must never have a live portal link, and a decided one has
 * nothing left to decide.
 *
 * Returns a typed error rather than throwing for the two expected failure modes.
 * The URL's TTL is the approval's `expires_at`, by construction: the token is a
 * column on the approval row and every lookup carries `expires_at > now()`.
 *
 * A re-mint rotates the token and kills the previous link. The plaintext is
 * returned exactly once, here. NEVER log it, never audit it, never place it in
 * LLM context except as the URL a model relays verbatim to its operator.
 */
export async function mintApprovalGrantUrl(
  input: MintApprovalGrantUrlInput,
): Promise<MintedApprovalGrantUrl | MintApprovalGrantUrlError> {
  const { db, approval } = input;

  // Checked before the write: a token nobody can be handed a URL for is a
  // capability minted for no one.
  const origin = engineUrlFromConfig();
  if (!origin) return { ok: false, error: "engine_public_url_missing" };

  const { plaintext, hash } = generateApprovalGrant();
  const updated = await db
    .update(toolApprovals)
    .set({ portal_token_sha256: hash })
    .where(
      and(
        eq(toolApprovals.id, approval.id),
        eq(toolApprovals.tenant_id, approval.tenant_id),
        isNull(toolApprovals.granted_at),
        isNull(toolApprovals.declined_at),
        isNull(toolApprovals.consumed_at),
        gt(toolApprovals.expires_at, sql`now()`),
      ),
    )
    .returning({ expires_at: toolApprovals.expires_at });

  const row = updated[0];
  if (!row) return { ok: false, error: "approval_not_pending" };

  const url = `${origin.replace(/\/+$/, "")}${APPROVAL_PORTAL_PATH}?grant=${encodeURIComponent(plaintext)}`;
  return { ok: true, url, expires_at: row.expires_at };
}

/** The decided state of an approval, as the portal must present it. */
export type ApprovalPortalState = "pending" | "granted" | "declined" | "consumed";

export interface ApprovalPortalView {
  readonly approval_id: string;
  readonly tenant_id: string;
  readonly tool: string;
  /** `wf_<slug>` → `<slug>`; null for every other tool. */
  readonly workflow_slug: string | null;
  readonly surface: string;
  readonly execution_mode: string | null;
  readonly expires_at: Date;
  readonly state: ApprovalPortalState;
  /** Present only while the approval is still `pending`. Once a decision has
   *  landed there is nothing left to weigh, and a replayed token must not
   *  re-expose the resolved request list. */
  readonly preview: ApprovalPreview | null;
}

function stateOf(row: {
  granted_at: Date | null;
  declined_at: Date | null;
  consumed_at: Date | null;
}): ApprovalPortalState {
  if (row.consumed_at) return "consumed";
  if (row.declined_at) return "declined";
  if (row.granted_at) return "granted";
  return "pending";
}

export function workflowSlugFromToolName(tool: string): string | null {
  return tool.startsWith(WORKFLOW_TOOL_PREFIX) ? tool.slice(WORKFLOW_TOOL_PREFIX.length) : null;
}

export function decryptPreview(row: {
  id: string;
  tenant_id: string;
  preview_ciphertext: Uint8Array | null;
  preview_iv: Uint8Array | null;
  preview_auth_tag: Uint8Array | null;
}): ApprovalPreview | null {
  const { preview_ciphertext, preview_iv, preview_auth_tag } = row;
  if (!preview_ciphertext || !preview_iv || !preview_auth_tag) return null;
  try {
    const plaintext = decryptSecret(
      { ciphertext: preview_ciphertext, iv: preview_iv, auth_tag: preview_auth_tag },
      previewAad(row.tenant_id, row.id),
    );
    const parsed = JSON.parse(plaintext) as { would_write?: unknown; prepared_workflow?: unknown };
    const binding = PreparedWorkflowBindingSchema.safeParse(parsed.prepared_workflow);
    return {
      would_write: normalizeWouldWrite(parsed.would_write),
      ...(binding.success ? { prepared_workflow: binding.data } : {}),
    };
  } catch (err) {
    // The page still renders — an undecryptable preview must not block a human
    // from declining. It withholds the write list and says so.
    logger.error({
      module: "tools",
      action: "approval.portal.preview_undecryptable",
      msg: "approval preview could not be decrypted; rendering the portal without a write list",
      approval_id: row.id,
      tenant_id: row.tenant_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve a portal grant token to the approval it was minted for.
 *
 * A plain SELECT — it does NOT consume anything. The token must survive the GET
 * that renders the page so the POST that carries the decision can present it
 * again; the decision itself is the single-use CAS, in `grantApproval` /
 * `declineApproval`.
 *
 * `expires_at > now()` is Postgres' clock, the same one the approval's TTL was
 * written with. An expired approval resolves to null: no live portal link.
 *
 * Returns null for an unknown, malformed, or expired token. The caller renders
 * one indistinguishable error page for all three — which approvals exist is not
 * an anonymous browser's to learn.
 */
export async function resolveApprovalPortalToken(
  db: Db,
  token: string,
): Promise<ApprovalPortalView | null> {
  const hash = parseApprovalGrant(token);
  if (!hash) return null;

  // tenant-filter:exempt — this is the browser-facing unauthenticated route.
  // The tenant is derived from the matched row ONLY.
  const rows = await db
    .select({
      id: toolApprovals.id,
      tenant_id: toolApprovals.tenant_id,
      tool: toolApprovals.tool,
      surface: toolApprovals.surface,
      execution_mode: toolApprovals.execution_mode,
      expires_at: toolApprovals.expires_at,
      granted_at: toolApprovals.granted_at,
      declined_at: toolApprovals.declined_at,
      consumed_at: toolApprovals.consumed_at,
      preview_ciphertext: toolApprovals.preview_ciphertext,
      preview_iv: toolApprovals.preview_iv,
      preview_auth_tag: toolApprovals.preview_auth_tag,
    })
    .from(toolApprovals)
    .where(
      and(eq(toolApprovals.portal_token_sha256, hash), gt(toolApprovals.expires_at, sql`now()`)),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const state = stateOf(row);
  return {
    approval_id: row.id,
    tenant_id: row.tenant_id,
    tool: row.tool,
    workflow_slug: workflowSlugFromToolName(row.tool),
    surface: row.surface,
    execution_mode: row.execution_mode,
    expires_at: row.expires_at,
    state,
    preview: state === "pending" ? decryptPreview(row) : null,
  };
}
