import { createHash } from "node:crypto";
import { ALLOWANCE_ENTERED_BY, DEVICE_ALLOWANCE_KINDS } from "@shared/device/boundary.ts";
import { DEVICE_CAPABILITIES, DEVICE_REFUSALS } from "@shared/device/protocol.ts";
import { z } from "zod";
import { RequestSourceSchema } from "../observability/service-metadata.ts";

export const DEVICE_LOSS_CODES = [
  "device_offline_timeout",
  "device_lost_during_write",
  "device_step_interrupted",
  "device_revoked",
] as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const deviceLabel = z.string().min(1).max(120);

export const DeviceRunnerAuditMetadataSchema = z
  .object({
    device_id: z.string().uuid(),
    device_label: deviceLabel,
    installation_id: z.string().uuid(),
    runner_version: z.string().min(1).max(64).optional(),
    reason: z.string().min(1).max(64).optional(),
    request_source: RequestSourceSchema.optional(),
  })
  .strict();

export const DeviceAllowanceAuditMetadataSchema = z
  .object({
    device_id: z.string().uuid(),
    device_label: deviceLabel,
    kind: z.enum(DEVICE_ALLOWANCE_KINDS),
    item_id: z.string().min(1).max(200),
    access: z.enum(["read", "write"]).optional(),
    private: z.boolean().optional(),
    entered_by: z.enum(ALLOWANCE_ENTERED_BY).optional(),
    digest: sha256,
    request_source: RequestSourceSchema.optional(),
  })
  .strict();

export const DeviceEffectAuditMetadataSchema = z
  .object({
    device_id: z.string().uuid(),
    device_label: deviceLabel,
    capability: z.enum(DEVICE_CAPABILITIES),
    folder_id: z.string().min(1).max(200).optional(),
    origin: z.string().min(1).max(300).optional(),
    app_id: z.string().min(1).max(200).optional(),
    relative_path: z.string().min(1).max(1024).optional(),
    relative_path_digest: sha256.optional(),
    command_id: sha256,
    generation: z.number().int().nonnegative(),
    execution_id: z.string().uuid().optional(),
    task_run_id: z.string().uuid().optional(),
    job_id: z.string().uuid().optional(),
    code: z.enum([...DEVICE_REFUSALS, ...DEVICE_LOSS_CODES]).optional(),
    request_source: RequestSourceSchema.optional(),
  })
  .strict();

export const LocalConfirmationAuditMetadataSchema = z
  .object({
    confirmation_id: z.string().uuid(),
    command_id: sha256,
    binding_hash: sha256,
    device_id: z.string().uuid(),
    execution_id: z.string().uuid().optional(),
    task_run_id: z.string().uuid().optional(),
    job_id: z.string().uuid().optional(),
    request_source: RequestSourceSchema.optional(),
  })
  .strict();

export const LocalWorkspaceAuditMetadataSchema = z
  .object({
    backup_id: z.string().min(1).max(200).optional(),
    size_bytes_bucket: z.enum(["<1KB", "<1MB", "<10MB", "<100MB", ">=100MB"]).optional(),
    engine_version: z.string().min(1).max(64).optional(),
    request_source: RequestSourceSchema.optional(),
  })
  .strict();

export function relativePathDigest(input: {
  device_id: string;
  folder_id: string;
  relative_path: string;
}): string {
  return createHash("sha256")
    .update(`${input.device_id}\u0000${input.folder_id}\u0000${input.relative_path}`)
    .digest("hex");
}

export type DeviceEffectAuditInput = Omit<
  z.input<typeof DeviceEffectAuditMetadataSchema>,
  "relative_path_digest"
>;

export function deviceEffectAuditMetadata(
  input: DeviceEffectAuditInput,
  privacy: "standard" | "sensitive",
): z.infer<typeof DeviceEffectAuditMetadataSchema> {
  const { relative_path, ...rest } = input;
  const digest =
    relative_path !== undefined && input.folder_id !== undefined
      ? relativePathDigest({
          device_id: input.device_id,
          folder_id: input.folder_id,
          relative_path,
        })
      : undefined;
  return DeviceEffectAuditMetadataSchema.parse({
    ...rest,
    ...(digest ? { relative_path_digest: digest } : {}),
    ...(relative_path !== undefined && privacy === "standard" ? { relative_path } : {}),
  });
}
