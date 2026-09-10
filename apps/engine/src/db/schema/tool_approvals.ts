// Human-in-the-loop tool approvals — the durable half of the confirm gate.
//
// One row per `APPROVAL_REQUESTED`. `id` IS the `tool_call_id` the policy
// gate minted and handed to the client as `confirm_id`, so the row and the
// `audit_log` lifecycle (APPROVAL_REQUESTED → APPROVAL_APPROVED) join on a
// single identifier.
//
// WHY THE ARGS ARE STORED: an approval is a CAPABILITY HANDLE, not a
// re-transmission challenge. Before this table the engine kept only
// `metadata.args_hash` on the audit row, so it could verify an echo but
// could not replay it — a model re-issuing a 50 KB payload byte-exactly is
// not a reachable contract. Persisting the args lets `consumeApproval`
// replay exactly what the operator approved, and removes the args from the
// model's control at approve time.
//
// Encryption: AES-256-GCM via `crypto/aes-gcm.ts`, AAD bound to
// `tenant_id:id`, so a ciphertext can never be lifted into another
// tenant's (or another approval's) row. The plaintext is the
// JSON-stringified tool args and may carry secrets the operator typed
// into a form — it is written encrypted, never logged, never rendered,
// never placed in LLM context.
//
// UNGRANTED AT MINT. A row is created with `granted_at IS NULL`. It becomes
// claimable only after a HUMAN grants it — through the approval portal, or as
// an optimization when a client actually fulfils an in-band elicitation
// prompt. `granted_via` records which channel the human used and
// `granted_by_user_id` records who they were. Neither the model nor the
// tool call that requested the approval can set them: `confirm_tool_call` is a
// TRIGGER that replays a decision already made, not the decision itself.
//
// Single-use + TTL: `consumed_at` is set by one atomic CAS
// (`granted_at IS NOT NULL AND declined_at IS NULL AND consumed_at IS NULL
// AND expires_at > now()`), so two concurrent confirmations of the same id can
// never both execute, and an ungranted or declined approval can never execute
// at all.
//
// Retention: the ciphertext is secret material, so a dead row is a
// liability, not an archive. `scheduler/tool-approvals-cleanup-runner.ts`
// deletes expired-unconsumed rows and consumed rows one day past the
// instant each stopped being claimable. Nothing here is a durable
// governance record — the APPROVAL_REQUESTED / APPROVAL_APPROVED /
// APPROVAL_REJECTED rows in `audit_log` are, and they outlive this table.
//
// The CAS predicate is the approval's binding: `(id, tenant_id,
// principal_id, tool, surface)`. `execution_mode` is bound too, but it is
// verified against the STORED row rather than re-supplied by the claim —
// see `tools/approval.ts`.

import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea, tenantId } from "./_common.ts";
import { tenants } from "./identity.ts";

export const toolApprovals = pgTable(
  "tool_approvals",
  {
    // = the `tool_call_id` / `confirm_id` handed to the client. Never
    // defaulted: the policy gate owns the id, and a row minted with a
    // random one could never be consumed.
    id: uuid("id").primaryKey(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    // The principal the approval was granted to. Polymorphic (`users.id`
    // or a system account), so no FK. Scoping the CAS on this column stops
    // principal A from consuming principal B's approval inside a tenant.
    principal_id: uuid("principal_id").notNull(),
    // Survives deletion of the run until approval-secret retention expires.
    // A consumed decision must never bind a second execution.
    claimed_execution_id: uuid("claimed_execution_id"),
    tool: text("tool").notNull(),
    // "chat" | "mcp" — the surface the approval was requested on. Part of the
    // CAS predicate: a chat-minted approval is not claimable over MCP.
    surface: text("surface").notNull(),
    // "dev" | "prod" — the execution environment the previewed call ran in,
    // when its surface has an ambient one. NULL when it does not (the
    // dispatcher, external MCP tools): there the environment, if any, is an
    // argument and therefore already covered by `args_ciphertext`.
    //
    // MCP `wf_<slug>` reads its environment out-of-band from
    // `_meta.environment`, so it is NOT covered by `args_hash`. Persisting it
    // is what stops a preview of `dev` from being confirmed into `prod`.
    execution_mode: text("execution_mode"),
    // AES-256-GCM ciphertext (see apps/engine/src/crypto/aes-gcm.ts). Writers call encryptSecret(), readers decryptSecret(), keyed by env.MASTER_KEY.
    // Plaintext is `JSON.stringify(args)`. AAD = `${tenant_id}:${id}`.
    args_ciphertext: bytea("args_ciphertext").notNull(),
    args_iv: bytea("args_iv").notNull(),
    args_auth_tag: bytea("args_auth_tag").notNull(),
    // `hashToolArgs()` of the approved args. Mirrors `metadata.args_hash`
    // on the APPROVAL_REQUESTED audit row. Re-checked after decrypt: a
    // mismatch means tampering at rest, not a client-side arg swap.
    args_hash: text("args_hash").notNull(),
    // AES-256-GCM ciphertext of the `would_write` preview a human must see
    // before approving — the exact requests a held-writes run resolved and
    // did not dispatch. AAD = `${tenant_id}:${id}:preview`, deliberately
    // distinct from the args AAD so a preview ciphertext can never be lifted
    // into `args_ciphertext` and replayed as the call's arguments. Encrypted,
    // not `jsonb`: a resolved URL can carry a query-mode credential. NULL for
    // gates that hold no writes (a `create_api_key` confirm previews nothing).
    preview_ciphertext: bytea("preview_ciphertext"),
    preview_iv: bytea("preview_iv"),
    preview_auth_tag: bytea("preview_auth_tag"),
    // SHA-256 hex of the single-use `skag_…` portal grant token. The plaintext
    // is returned once at mint time (`tools/approval-portal.ts`) and never
    // persisted. It lives HERE rather than in a grants table of its own so the
    // link's lifetime IS the approval's `expires_at` — an expired approval
    // cannot have a live portal link, and the retention sweep that deletes the
    // ciphertext deletes the token with it. NULL when the engine has no
    // configured public origin to build a URL from.
    portal_token_sha256: text("portal_token_sha256"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    // NULL until a human grants the approval. The claim CAS requires it.
    granted_at: timestamp("granted_at", { withTimezone: true }),
    // The human who granted it. No FK to `users`: deleting a user must not
    // cascade away the approval, and the durable governance record is the
    // APPROVAL_GRANTED row in `audit_log`, which outlives this table. NULL
    // when the granting principal is not a user (a system account answering an
    // in-band elicitation on an operator's behalf).
    granted_by_user_id: uuid("granted_by_user_id"),
    // "portal" | "in_band_elicitation" | "chat" — the channel the human
    // decided through. `portal` is the reachable one for every MCP client;
    // the others are optimizations for surfaces that can reach a human inside
    // the call.
    granted_via: text("granted_via"),
    // Terminal: a human said no. Distinct from "never granted" so a claim can
    // tell the model to stop asking instead of pointing it at the portal.
    declined_at: timestamp("declined_at", { withTimezone: true }),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("tool_approvals_tenant_id_idx").on(t.tenant_id, t.id),
    // TTL sweep — only unconsumed rows can expire, so the sweeper's
    // `expires_at < now() - interval` scan never walks the consumed tail.
    // The sweeper is `scheduler/tool-approvals-cleanup-runner.ts`, fired
    // hourly by the reconciler; its expired-approval DELETE carries this
    // exact predicate.
    index("tool_approvals_expiry_sweep_idx").on(t.expires_at).where(sql`${t.consumed_at} IS NULL`),
    // The portal's only lookup key. Unique so a token can name at most one
    // approval; Postgres allows many NULLs, which is what an approval with no
    // minted link carries.
    uniqueIndex("tool_approvals_portal_token_sha256_key").on(t.portal_token_sha256),
  ],
);

export type ToolApprovalRow = typeof toolApprovals.$inferSelect;
