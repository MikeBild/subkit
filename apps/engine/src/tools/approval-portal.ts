import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto/index.ts";
import type { Db, Executor } from "../db/client.ts";
import { withSystemScope, withTenantScope } from "../db/index.ts";
import { systemAccounts, toolApprovals, users } from "../db/schema/index.ts";
import { CallerContextSchema } from "../execution/caller-context.ts";
import { sha256Hex } from "../identity/api-key.ts";
import { engineUrlFromConfig } from "../llm/runtime-context.ts";
import { logger } from "../logging/index.ts";
import { type ApprovalSubject, ApprovalSubjectSchema } from "./approval-subject.ts";
import {
  type DirectConnectorBinding,
  DirectConnectorBindingSchema,
} from "./direct-connector-binding.ts";
import {
  type PreparedWorkflowBinding,
  PreparedWorkflowBindingSchema,
} from "./prepared-workflow-approval.ts";

export const APPROVAL_PORTAL_PATH = "/v1/tool-approvals/decide";

const APPROVAL_GRANT_PREFIX = "skag_";

const WORKFLOW_TOOL_PREFIX = "wf_";

interface IssuedApprovalGrant {
  readonly plaintext: string;
  readonly hash: string;
}

function generateApprovalGrant(): IssuedApprovalGrant {
  const rand = randomBytes(24).toString("base64url");
  const plaintext = `${APPROVAL_GRANT_PREFIX}${rand}`;
  return { plaintext, hash: sha256Hex(plaintext) };
}

function parseApprovalGrant(token: string): string | null {
  if (!token.startsWith(APPROVAL_GRANT_PREFIX)) return null;
  if (token.length < APPROVAL_GRANT_PREFIX.length + 20) return null;
  return sha256Hex(token);
}

export interface ApprovalWouldWrite {
  readonly step: string;
  readonly method: string | null;
  readonly url: string | null;
}

export interface ApprovalPreview {
  readonly would_write: readonly ApprovalWouldWrite[];
  readonly prepared_workflow?: PreparedWorkflowBinding;
  readonly direct_connector?: DirectConnectorBinding;
  readonly subject?: ApprovalSubject;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeWouldWrite(value: unknown): ApprovalWouldWrite[] {
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

export function buildApprovalPreview(
  details: { readonly would_write?: unknown } | undefined,
): ApprovalPreview | null {
  const would_write = normalizeWouldWrite(details?.would_write);
  return would_write.length > 0 ? { would_write } : null;
}

function previewAad(tenant_id: string, approval_id: string): string {
  return `${tenant_id}:${approval_id}:preview`;
}

interface EncryptedApprovalPreview {
  readonly preview_ciphertext: Uint8Array;
  readonly preview_iv: Uint8Array;
  readonly preview_auth_tag: Uint8Array;
}

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

type MintApprovalGrantUrlError = {
  readonly ok: false;
  readonly error: "engine_public_url_missing" | "approval_not_pending";
};

interface MintedApprovalGrantUrl {
  readonly ok: true;
  readonly url: string;
  readonly expires_at: Date;
}

interface MintApprovalGrantUrlInput {
  readonly db: Executor;
  readonly approval: { readonly id: string; readonly tenant_id: string };
}

export async function mintApprovalGrantUrl(
  input: MintApprovalGrantUrlInput,
): Promise<MintedApprovalGrantUrl | MintApprovalGrantUrlError> {
  const { db, approval } = input;

  const origin = engineUrlFromConfig();
  if (!origin) return { ok: false, error: "engine_public_url_missing" };

  const { plaintext, hash } = generateApprovalGrant();
  const updated = await withTenantScope(db, approval.tenant_id, (tx) =>
    tx
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
      .returning({ expires_at: toolApprovals.expires_at }),
  );

  const row = updated[0];
  if (!row) return { ok: false, error: "approval_not_pending" };

  const url = `${origin.replace(/\/+$/, "")}${APPROVAL_PORTAL_PATH}?grant=${encodeURIComponent(plaintext)}`;
  return { ok: true, url, expires_at: row.expires_at };
}

export type ApprovalPortalState = "pending" | "granted" | "declined" | "consumed";

export interface ApprovalRequester {
  kind: "user" | "system_account";
  id: string;
  label: string | null;
}

export function approvalRequesterIdentity(row: {
  tenant_id: string;
  principal_id: string;
  caller_context: unknown;
}): Omit<ApprovalRequester, "label"> | null {
  const parsed = CallerContextSchema.safeParse(row.caller_context);
  if (
    !parsed.success ||
    parsed.data.tenantId !== row.tenant_id ||
    parsed.data.principalId !== row.principal_id
  )
    return null;
  return { kind: parsed.data.principalKind, id: parsed.data.principalId };
}

async function approvalRequester(
  db: Db,
  row: { tenant_id: string; principal_id: string; caller_context: unknown },
): Promise<ApprovalRequester | null> {
  const identity = approvalRequesterIdentity(row);
  if (!identity) return null;
  const labels =
    identity.kind === "user"
      ? await db
          .select({ label: users.email })
          .from(users)
          .where(and(eq(users.tenant_id, row.tenant_id), eq(users.id, identity.id)))
          .limit(1)
      : await db
          .select({ label: systemAccounts.name })
          .from(systemAccounts)
          .where(
            and(eq(systemAccounts.tenant_id, row.tenant_id), eq(systemAccounts.id, identity.id)),
          )
          .limit(1);
  return { ...identity, label: labels[0]?.label ?? null };
}

export interface ApprovalPortalView {
  readonly requester?: ApprovalRequester | null;
  readonly approval_id: string;
  readonly tenant_id: string;
  readonly tool: string;
  readonly workflow_slug: string | null;
  readonly surface: string;
  readonly execution_mode: string | null;
  readonly expires_at: Date;
  readonly state: ApprovalPortalState;
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

function workflowSlugFromToolName(tool: string): string | null {
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
    const parsed = JSON.parse(plaintext) as {
      would_write?: unknown;
      prepared_workflow?: unknown;
      direct_connector?: unknown;
      subject?: unknown;
    };
    const binding = PreparedWorkflowBindingSchema.safeParse(parsed.prepared_workflow);
    const direct = DirectConnectorBindingSchema.safeParse(parsed.direct_connector);
    const subject = ApprovalSubjectSchema.safeParse(parsed.subject);
    return {
      would_write: normalizeWouldWrite(parsed.would_write),
      ...(binding.success ? { prepared_workflow: binding.data } : {}),
      ...(direct.success ? { direct_connector: direct.data } : {}),
      ...(subject.success ? { subject: subject.data } : {}),
    };
  } catch (err) {
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

export async function resolveApprovalPortalToken(
  db: Db,
  token: string,
): Promise<ApprovalPortalView | null> {
  const hash = parseApprovalGrant(token);
  if (!hash) return null;

  // tenant-filter:exempt — this is the browser-facing unauthenticated route.
  // The tenant is derived from the matched row ONLY.
  const rows = await withSystemScope(db, "approval portal lookup by grant hash", (tx) =>
    tx
      .select({
        id: toolApprovals.id,
        tenant_id: toolApprovals.tenant_id,
        principal_id: toolApprovals.principal_id,
        caller_context: toolApprovals.caller_context,
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
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;

  const state = stateOf(row);
  return {
    approval_id: row.id,
    tenant_id: row.tenant_id,
    requester: state === "pending" ? await approvalRequester(db, row) : null,
    tool: row.tool,
    workflow_slug: workflowSlugFromToolName(row.tool),
    surface: row.surface,
    execution_mode: row.execution_mode,
    expires_at: row.expires_at,
    state,
    preview: state === "pending" ? decryptPreview(row) : null,
  };
}

export async function findActiveApproverEmail(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        eq(users.tenant_id, tenantId),
        eq(users.status, "active"),
        isNull(users.deleted_at),
      ),
    )
    .limit(1);
  return user?.email ?? null;
}
