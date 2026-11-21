import { z } from "zod";

export const DEVICE_CAPABILITIES = ["files", "browser", "computer"] as const;
export const DeviceCapabilitySchema = z.enum(DEVICE_CAPABILITIES);
export type DeviceCapability = z.infer<typeof DeviceCapabilitySchema>;

export const DEVICE_COMMAND_KINDS = [
  "files.list",
  "files.read_text",
  "files.import",
  "files.write",
  "files.mkdir",
  "files.move",
  "files.trash",
  "browser.open",
  "browser.wait",
  "browser.extract",
  "browser.fill",
  "browser.press",
  "browser.download",
  "browser.pdf",
  "browser.snapshot",
  "browser.screenshot",
  "browser.handover",
  "computer.apps",
  "computer.open",
  "computer.snapshot",
  "computer.find",
  "computer.screenshot",
  "computer.press",
  "computer.focus",
  "computer.select",
  "computer.set_value",
  "computer.type",
  "computer.key",
  "computer.scroll",
  "computer.handover",
] as const;
export const DeviceCommandKindSchema = z.enum(DEVICE_COMMAND_KINDS);
export type DeviceCommandKind = z.infer<typeof DeviceCommandKindSchema>;

export function capabilityOfKind(kind: DeviceCommandKind): DeviceCapability {
  if (kind.startsWith("files.")) return "files";
  if (kind.startsWith("browser.")) return "browser";
  return "computer";
}

export const DEVICE_REFUSALS = [
  "outside_allowance",
  "outside_boundary",
  "folder_changed",
  "path_moved",
  "secret_file",
  "hidden_path",
  "executable",
  "too_large",
  "private_address",
  "origin_not_allowed",
  "credential_field",
  "blocked_app",
  "blocked_shortcut",
  "secure_focus",
  "stale",
  "owner_active",
  "stopped",
  "deadline_passed",
  "permission_missing",
  "trash_unavailable",
] as const;
export const DeviceRefusalSchema = z.enum(DEVICE_REFUSALS);
export type DeviceRefusal = z.infer<typeof DeviceRefusalSchema>;

export const CONFIRMATION_TARGET_MAX = 500;
export const ConfirmationTargetSchema = z.string().min(1).max(CONFIRMATION_TARGET_MAX);

export const ConfirmationRefSchema = z
  .object({
    confirmation_id: z.string().min(1),
    binding_hash: z.string().min(1),
  })
  .strict();
export type ConfirmationRef = z.infer<typeof ConfirmationRefSchema>;

export const DeviceCommandSchema = z
  .object({
    command_id: z.string().min(1),
    tenant_id: z.string().min(1),
    execution_id: z.string().min(1).nullable(),
    task_run_id: z.string().min(1).nullable(),
    conversation_id: z.string().min(1).nullable(),
    step_id: z.string().min(1),
    authority_id: z.string().min(1).nullable(),
    manifest_digest: z.string().min(1).nullable(),
    kind: DeviceCommandKindSchema,
    args: z.unknown(),
    deadline_at: z.iso.datetime({ offset: true }),
    generation: z.number().int().nonnegative(),
    confirmation: ConfirmationRefSchema.nullable(),
  })
  .strict();
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;

export const DeviceEvidenceSchema = z
  .object({
    before_version: z.string().min(1).optional(),
    after_version: z.string().min(1).optional(),
    screenshot_ref: z.string().min(1).optional(),
  })
  .strict();
export type DeviceEvidence = z.infer<typeof DeviceEvidenceSchema>;

export const DeviceResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("done"),
      output: z.unknown(),
      evidence: DeviceEvidenceSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      code: DeviceRefusalSchema,
      detail: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("confirmation_required"),
      binding_hash: z.string().min(1),
      target: ConfirmationTargetSchema,
    })
    .strict(),
  z.object({ status: z.literal("stopped") }).strict(),
  z
    .object({
      status: z.literal("failed"),
      code: z.string().min(1),
      detail: z.string(),
    })
    .strict(),
]);
export type DeviceResult = z.infer<typeof DeviceResultSchema>;

export const DEVICE_RESULT_STATUSES = [
  "done",
  "refused",
  "confirmation_required",
  "stopped",
  "failed",
] as const;
export type DeviceResultStatus = (typeof DEVICE_RESULT_STATUSES)[number];

export const DEVICE_OS = ["darwin", "win32"] as const;
export const DeviceOsSchema = z.enum(DEVICE_OS);
export type DeviceOs = z.infer<typeof DeviceOsSchema>;

export const HeartbeatSchema = z
  .object({
    runner_version: z.string().min(1),
    os: DeviceOsSchema,
    capabilities: z.array(DeviceCapabilitySchema),
    personal: z.array(DeviceCapabilitySchema),
    permissions: z
      .object({
        accessibility: z.boolean().optional(),
        screen: z.boolean().optional(),
      })
      .strict(),
    allowances_digest: z.string().min(1),
    generation: z.number().int().nonnegative(),
  })
  .strict();
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export const DeviceStopReportSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    stopped_at: z.iso.datetime({ offset: true }),
    command_id: z.string().min(1).optional(),
  })
  .strict();
export type DeviceStopReport = z.infer<typeof DeviceStopReportSchema>;
