// Shared chat-domain helpers used by the HTTP route layer, the
// dispatcher, and the per-platform adapters.
//
// Single source of truth — duplicates surface across the chat surface
// as two-OpenAPI-component drift, audit-action mismatches, and
// "added the new ask_user_* tool in one place, forgot the other"
// regressions. Anything that ties chat-domain primitives together
// goes here:
//
//   * `ChatPlatformZodEnum` — the Zod enum for "slack"|"teams"|
//     "google_chat" with one fixed OpenAPI component name
//     ("ChatPlatform"). Both `chat-workspaces.ts` and
//     `chat-identities.ts` import this so the generated OpenAPI
//     client carries ONE `ChatPlatform` schema, not two diverging
//     copies.
//   * `mapToolNameToKind(toolName)` — maps `ask_user_confirm` →
//     "confirm", etc. The dispatcher uses this to decide whether to
//     call `adapter.renderElicitation` based on `capabilities`; the
//     Slack adapter uses it inside `handleSyncInteraction` to build
//     a `ChatElicitation` for the modal view. Same function, one
//     home.
//   * `aadFor(tenant, row_id)` — the AES-GCM AAD pattern that binds
//     a `chat_workspaces` row's ciphertext to its (tenant, id).
//     Mirrors `webhooks/inbound/service.ts aadFor`. Install + boot
//     hydration both encrypt/decrypt with this AAD.

import { z } from "@hono/zod-openapi";
import type { ElicitationKind } from "./types.ts";

/** Zod enum for the chat platform tag, with a single canonical
 *  OpenAPI component name. Importing this everywhere (instead of
 *  rolling a fresh `z.enum(...)` per route file) keeps the generated
 *  TS client carrying ONE `ChatPlatform` schema. */
export const ChatPlatformZodEnum = z
  .enum(["slack", "teams", "google_chat"])
  .openapi("ChatPlatform");

/** Map an `ask_user_*` tool name to a provider-neutral elicitation
 *  kind. The dispatcher branches on `capabilities.interactive`
 *  without knowing tool naming details; platform adapters use the
 *  same mapping when building a ChatElicitation from a persisted
 *  elicitation row. */
export function mapToolNameToKind(toolName: string): ElicitationKind {
  switch (toolName) {
    case "ask_user_confirm":
      return "confirm";
    case "ask_user_choice":
      return "choice";
    case "ask_user_multi":
      return "multi";
    case "ask_user_text":
      return "text";
    case "ask_user_form":
      return "form";
    default:
      return "confirm";
  }
}

/** AES-GCM AAD for chat_workspaces rows. Mirrors the
 *  `webhooks/inbound/service.ts aadFor` pattern: the AAD is bound to
 *  the tenant AND the row id so a row hijack can't reuse another
 *  row's ciphertext under a different identity. */
export function chatWorkspaceAad(tenant_id: string, workspace_row_id: string): string {
  return `chat-workspace:${tenant_id}:${workspace_row_id}`;
}
