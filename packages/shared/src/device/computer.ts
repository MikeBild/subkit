import { z } from "zod";
import { DeviceSubBoundarySchema } from "./boundary.ts";
import { HandoverReasonSchema } from "./browser.ts";

export const COMPUTER_REF_PATTERN = /^@s[a-z0-9]{1,64}:e[1-9][0-9]{0,6}$/;
export const COMPUTER_WINDOW_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const COMPUTER_TEXT_MAX_BYTES = 10_000;

export const FILE_DIALOG_REFUSAL = {
  de: "Datei-Dialoge bedienst du selbst; für Dateien nutzt SubKit die freigegebenen Ordner. Es wurde nichts gesendet.",
  en: "File dialogs are yours to use; for files SubKit uses the allowed folders. Nothing was sent.",
} as const;
export const COMPUTER_VALUE_MAX_BYTES = 131_072;
export const COMPUTER_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

const boundary = DeviceSubBoundarySchema.optional();
const windowId = z.string().regex(COMPUTER_WINDOW_PATTERN);
const ref = z.string().regex(COMPUTER_REF_PATTERN);
const stateHash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .optional();

function utf8Max(max: number) {
  return z
    .string()
    .refine((text) => Buffer.byteLength(text, "utf8") <= max && !text.includes("\0"));
}

export const ComputerAppsArgsSchema = z.object({ boundary }).strict();
export const ComputerHandoverArgsSchema = z
  .object({ boundary, reason: HandoverReasonSchema })
  .strict();
export const ComputerWindowArgsSchema = z.object({ window_id: windowId, boundary }).strict();
export const ComputerRefArgsSchema = z
  .object({ window_id: windowId, ref, state_hash: stateHash, boundary })
  .strict();
export const ComputerTypeArgsSchema = ComputerRefArgsSchema.extend({
  text: utf8Max(COMPUTER_TEXT_MAX_BYTES),
}).strict();
export const ComputerSetValueArgsSchema = ComputerRefArgsSchema.extend({
  value: utf8Max(COMPUTER_VALUE_MAX_BYTES),
}).strict();
export const ComputerSelectArgsSchema = ComputerRefArgsSchema.extend({
  option: z.string().min(1).max(500),
}).strict();
export const ComputerScrollArgsSchema = ComputerRefArgsSchema.extend({
  direction: z.enum(COMPUTER_SCROLL_DIRECTIONS),
  amount: z.number().int().min(1).max(20),
}).strict();
export const ComputerKeyArgsSchema = z
  .object({ window_id: windowId, keys: z.string().min(1).max(64), state_hash: stateHash, boundary })
  .strict();

export type ComputerRefArgs = z.infer<typeof ComputerRefArgsSchema>;
export type ComputerKeyArgs = z.infer<typeof ComputerKeyArgsSchema>;

export const ComputerAuditSchema = z
  .object({
    app_bundle_id: z.string().min(1).max(255),
    action: z.string().min(1).max(64),
    ax_role: z.string().min(1).max(64).nullable(),
    label_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
export type ComputerAudit = z.infer<typeof ComputerAuditSchema>;
