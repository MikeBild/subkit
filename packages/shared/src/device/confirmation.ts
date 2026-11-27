import { z } from "zod";
import { ConfirmationTargetSchema, DeviceCapabilitySchema } from "./protocol.ts";

export const LOCAL_CONFIRMATION_KIND = "local_confirmation";

export const LocalConfirmationSchema = z
  .object({
    device_id: z.string().min(1),
    capability: DeviceCapabilitySchema,
    target: ConfirmationTargetSchema,
    deadline_at: z.iso.datetime({ offset: true }),
    command_id: z.string().min(1).nullable(),
    binding_hash: z.string().min(1).nullable(),
  })
  .strict();
export type LocalConfirmation = z.infer<typeof LocalConfirmationSchema>;

export const LOCAL_CONFIRMATION_PROMPT = {
  device: LocalConfirmationSchema.optional().describe(
    "The device, capability, redacted target and deadline of a local step that asks (kind local_confirmation).",
  ),
  payment_id: z
    .uuid()
    .optional()
    .describe(
      "Set when the local step pays with a card: approve the payment with POST /v1/vault/payments/{payment_id}/approve (CVV) instead of confirming here. Confirming without an approved payment pays nothing.",
    ),
} as const;

const CarrierSchema = z.looseObject({ device: LocalConfirmationSchema });

export function localConfirmationOf(value: unknown): LocalConfirmation | null {
  const parsed = CarrierSchema.safeParse(value);
  return parsed.success ? parsed.data.device : null;
}
