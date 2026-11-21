import { z } from "zod";
import { DeviceCapabilitySchema } from "./protocol.ts";

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const FOLDER_ACCESS = ["read", "write"] as const;
export const FolderAccessSchema = z.enum(FOLDER_ACCESS);
export type FolderAccess = z.infer<typeof FolderAccessSchema>;

export const DeviceBoundaryFolderSchema = z
  .object({
    folder_id: z.string().min(1),
    access: FolderAccessSchema,
    root_digest: sha256Hex,
  })
  .strict();
export type DeviceBoundaryFolder = z.infer<typeof DeviceBoundaryFolderSchema>;

export const DeviceBoundarySiteSchema = z
  .object({
    origin: z.string().min(1),
    private: z.boolean(),
    site_digest: sha256Hex,
  })
  .strict();
export type DeviceBoundarySite = z.infer<typeof DeviceBoundarySiteSchema>;

export const DeviceBoundaryAppSchema = z
  .object({
    app_id: z.string().min(1),
    app_digest: sha256Hex,
  })
  .strict();
export type DeviceBoundaryApp = z.infer<typeof DeviceBoundaryAppSchema>;

export const DeviceSubBoundarySchema = z
  .object({
    device_id: z.string().min(1),
    capability: DeviceCapabilitySchema,
    folders: z.array(DeviceBoundaryFolderSchema).optional(),
    sites: z.array(DeviceBoundarySiteSchema).optional(),
    apps: z.array(DeviceBoundaryAppSchema).optional(),
  })
  .strict();
export type DeviceSubBoundary = z.infer<typeof DeviceSubBoundarySchema>;

export const ALLOWANCE_ENTERED_BY = ["person", "approval"] as const;
export const AllowanceEnteredBySchema = z.enum(ALLOWANCE_ENTERED_BY);
export type AllowanceEnteredBy = z.infer<typeof AllowanceEnteredBySchema>;

export const DEVICE_ALLOWANCE_KINDS = ["folder", "site", "app", "keep_out"] as const;
export type DeviceAllowanceKind = (typeof DEVICE_ALLOWANCE_KINDS)[number];

export const FolderAllowanceSchema = z
  .object({
    kind: z.literal("folder"),
    id: z.string().min(1),
    display: z.string().min(1),
    access: FolderAccessSchema,
    digest: sha256Hex,
    entered_by: AllowanceEnteredBySchema,
  })
  .strict();
export type FolderAllowance = z.infer<typeof FolderAllowanceSchema>;

export const SiteAllowanceSchema = z
  .object({
    kind: z.literal("site"),
    id: z.string().min(1),
    origin: z.string().min(1),
    private: z.boolean(),
    digest: sha256Hex,
    entered_by: AllowanceEnteredBySchema,
  })
  .strict();
export type SiteAllowance = z.infer<typeof SiteAllowanceSchema>;

export const AppAllowanceSchema = z
  .object({
    kind: z.literal("app"),
    id: z.string().min(1),
    display: z.string().min(1),
    digest: sha256Hex,
    entered_by: AllowanceEnteredBySchema,
  })
  .strict();
export type AppAllowance = z.infer<typeof AppAllowanceSchema>;

export const KeepOutAllowanceSchema = z
  .object({
    kind: z.literal("keep_out"),
    id: z.string().min(1),
    target: z.enum(["folder", "app"]),
    display: z.string().min(1),
    entered_by: z.literal("person"),
  })
  .strict();
export type KeepOutAllowance = z.infer<typeof KeepOutAllowanceSchema>;

export const DeviceAllowanceSchema = z.discriminatedUnion("kind", [
  FolderAllowanceSchema,
  SiteAllowanceSchema,
  AppAllowanceSchema,
  KeepOutAllowanceSchema,
]);
export type DeviceAllowance = z.infer<typeof DeviceAllowanceSchema>;

export interface RootDigestInput {
  readonly device_id: string;
  readonly real_path: string;
  readonly volume_id: string;
  readonly file_id: string;
}

export interface SiteDigestInput {
  readonly device_id: string;
  readonly origin: string;
  readonly private: boolean;
}

export interface AppDigestInput {
  readonly device_id: string;
  readonly bundle_id: string;
  readonly team_id: string | null;
}

export function rootDigestMaterial(input: RootDigestInput): string {
  return JSON.stringify(["root", input.device_id, input.real_path, input.volume_id, input.file_id]);
}

export function siteDigestMaterial(input: SiteDigestInput): string {
  return JSON.stringify(["site", input.device_id, input.origin, input.private]);
}

export function appDigestMaterial(input: AppDigestInput): string {
  return JSON.stringify(["app", input.device_id, input.bundle_id, input.team_id]);
}
