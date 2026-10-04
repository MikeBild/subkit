import { z } from "@hono/zod-openapi";
import type { ElicitationKind } from "./types.ts";

export const ChatPlatformZodEnum = z
  .enum(["slack", "teams", "google_chat"])
  .openapi("ChatPlatform");

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

export function chatWorkspaceAad(tenant_id: string, workspace_row_id: string): string {
  return `chat-workspace:${tenant_id}:${workspace_row_id}`;
}

export const ConfirmOutputSchema = z.object({ confirmed: z.boolean() });
export const ChoiceOutputSchema = z.object({ value: z.string().min(1) });
export const MultiOutputSchema = z.object({ values: z.array(z.string()) });
export const TextOutputSchema = z.object({ text: z.string() });
export const FormOutputSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
);

const ELIC_KINDS = ["confirm", "choice", "multi", "text", "form"] as const;

export const ChatInteractionEnvelopeSchema = z.object({
  c: z.string().uuid(),
  o: z.unknown().optional(),
});

export function encodeInteractionEnvelope(conversation_id: string, output: unknown): string {
  return JSON.stringify({ c: conversation_id, o: output });
}

export const ChatViewMetadataSchema = z.object({
  c: z.string().uuid(),
  e: z.string().uuid(),
  k: z.enum(ELIC_KINDS),
});

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
    user_id: z.string(),
    kind: z.enum(["mention", "slash_command", "interaction", "system"]),
    text: z.string().optional(),
    command: ChatCommandSchema.optional(),
    interaction: ChatInteractionActionSchema.optional(),
    system_event: z.string().optional(),
    is_direct_message: z.boolean().optional(),
    event_key: z.string().optional(),
    traffic_class: z.enum(["organic", "synthetic", "internal"]).optional(),
    raw: z.unknown(),
  })
  .passthrough();

export const ChatEventJobSchema = z.object({ event: ChatEventSchema });

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
