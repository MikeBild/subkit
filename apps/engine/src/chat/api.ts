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
 *  elicitation row. Returns null for an unknown tool name — the
 *  caller should fall back to the legacy `sendApproval` path rather
 *  than guess a kind (e.g. silently rendering Approve/Reject for a
 *  newly-added ask_user_* tool would mis-shape the user's answer). */
export function mapToolNameToKind(toolName: string): ElicitationKind | null {
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
      return null;
  }
}

/** AES-GCM AAD for chat_workspaces rows. Mirrors the
 *  `webhooks/inbound/service.ts aadFor` pattern: the AAD is bound to
 *  the tenant AND the row id so a row hijack can't reuse another
 *  row's ciphertext under a different identity. */
export function chatWorkspaceAad(tenant_id: string, workspace_row_id: string): string {
  return `chat-workspace:${tenant_id}:${workspace_row_id}`;
}

// ---------------------------------------------------------------------
// Elicitation-output schemas — per ElicitationKind.
//
// The dispatcher receives a Block-Kit `value` JSON envelope `{c, o}`
// or a `view_submission.private_metadata` + `form_values` from
// adapter `receive()`. Slack signs the outer payload so the user is
// authenticated, but the SHAPE of `o` (and `form_values`) is still
// attacker-controlled. These schemas validate the per-kind shape
// before the dispatcher hands the output to `respondElicitation` so
// a malformed envelope can't sneak deep into the conversation
// pipeline (e.g. `output: {}` matching a "rejected" branch and
// silently rejecting another user's elicitation).
// ---------------------------------------------------------------------

export const ConfirmOutputSchema = z.object({ confirmed: z.boolean() });
export const ChoiceOutputSchema = z.object({ value: z.string().min(1) });
export const MultiOutputSchema = z.object({ values: z.array(z.string()) });
export const TextOutputSchema = z.object({ text: z.string() });
/** form output is a flat field-name → primitive dict; we accept
 *  any well-typed JSON primitive (string / number / boolean / null)
 *  and reject deeply-nested or array-of-object shapes. */
export const FormOutputSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
);

// ---------------------------------------------------------------------
// Interaction envelope schemas — Block-Kit value + view private_metadata.
//
// `interaction.value` carries the conversation_id + typed elicitation
// output: `{c: <conv_uuid>, o: <typed-output>}`. `view.private_metadata`
// (Slack modal submissions) carries `{c: <conv_uuid>, e: <elic_uuid>,
// k: <kind>}`. The strings are attacker-controlled — Slack signs the
// outer payload, but not the contents of these fields. Validate at
// the parse boundary instead of via hand-rolled `typeof x === "string"`
// checks so a contract drift surfaces as a schema rejection.
// ---------------------------------------------------------------------

const ELIC_KINDS = ["confirm", "choice", "multi", "text", "form"] as const;

export const ChatInteractionEnvelopeSchema = z.object({
  c: z.string().uuid(),
  o: z.unknown().optional(),
});

export const ChatViewMetadataSchema = z.object({
  c: z.string().uuid(),
  e: z.string().uuid(),
  k: z.enum(ELIC_KINDS),
});

// ---------------------------------------------------------------------
// Queue job envelope — schema for `chat.event` pg-boss jobs.
//
// pg-boss persists jobs in Postgres and rehydrates them after restart;
// a schema drift between enqueue and dequeue (e.g. a `ChatEvent`
// field renamed across deploys) would silently dispatch malformed
// events. Parse at the worker boundary so the drift fails loudly.
// ---------------------------------------------------------------------

const ChatPlatformSchema = z.enum(["slack", "teams", "google_chat"]);

const ChatInteractionActionSchema = z
  .object({
    action_id: z.string().min(1),
    value: z.string().optional(),
    form_values: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const ChatCommandSchema = z.union([
  z.object({ verb: z.literal("chat"), prompt: z.string() }),
  z.object({
    verb: z.literal("run"),
    workflow: z.string(),
    args: z.record(z.string(), z.string()),
  }),
  z.object({ verb: z.literal("help"), topic: z.string().optional() }),
]);

const ChatEventSchema = z
  .object({
    platform: ChatPlatformSchema,
    workspace_id: z.string().min(1),
    channel_id: z.string().min(1),
    thread_id: z.string().optional(),
    user_id: z.string().min(1),
    kind: z.enum(["mention", "slash_command", "interaction"]),
    text: z.string().optional(),
    command: ChatCommandSchema.optional(),
    interaction: ChatInteractionActionSchema.optional(),
    event_key: z.string().optional(),
    raw: z.unknown(),
  })
  .passthrough();

export const ChatEventJobSchema = z.object({ event: ChatEventSchema });

/** Validate an elicitation output against its declared kind. Returns
 *  the parsed typed value on success or null on failure (the caller
 *  logs a warn and short-circuits). */
export function validateElicitationOutput(
  kind: ElicitationKind,
  raw: unknown,
): Record<string, unknown> | null {
  const schema = (() => {
    switch (kind) {
      case "confirm":
        return ConfirmOutputSchema;
      case "choice":
        return ChoiceOutputSchema;
      case "multi":
        return MultiOutputSchema;
      case "text":
        return TextOutputSchema;
      case "form":
        return FormOutputSchema;
    }
  })();
  const parsed = schema.safeParse(raw);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}
