import { ALLOWANCE_ENTERED_BY, DEVICE_ALLOWANCE_KINDS } from "@shared/device/boundary.ts";
import { DEVICE_CAPABILITIES, DEVICE_REFUSALS } from "@shared/device/protocol.ts";
import { scrubSecrets } from "../logging/scrub-secrets.ts";
import { UUID_RE } from "../utils/index.ts";
import { DEVICE_LOSS_CODES } from "./device-metadata.ts";
import { sanitizeForAudit } from "./sanitize.ts";
import type { AuditEntry } from "./types.ts";

type Detail = string | number | boolean | null;
type DetailCheck = (value: unknown) => Detail | undefined;

const SHA256 = /^[0-9a-f]{64}$/;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.:[\]-]{1,253}$/;
const ITEM_ID = /^[A-Za-z0-9._:/-]{1,200}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,64}$/;

function matching(pattern: RegExp): DetailCheck {
  return (value) => (typeof value === "string" && pattern.test(value) ? value : undefined);
}

function oneOf(allowed: readonly string[]): DetailCheck {
  return (value) => (typeof value === "string" && allowed.includes(value) ? value : undefined);
}

function text(max: number): DetailCheck {
  return (value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
    return sanitizeForAudit(scrubSecrets(value) as string, max);
  };
}

const flag: DetailCheck = (value) => (typeof value === "boolean" ? value : undefined);
const count: DetailCheck = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const id = matching(UUID_RE);
const digest = matching(SHA256);
const label = text(120);
const code = oneOf([...DEVICE_REFUSALS, ...DEVICE_LOSS_CODES]);

const RUNNER = {
  device_id: id,
  device_label: label,
  installation_id: id,
  runner_version: matching(VERSION),
  reason: matching(/^[a-z_]{1,64}$/),
};

const ALLOWANCE = {
  device_id: id,
  device_label: label,
  kind: oneOf(DEVICE_ALLOWANCE_KINDS),
  item_id: matching(ITEM_ID),
  access: oneOf(["read", "write"]),
  private: flag,
  entered_by: oneOf(ALLOWANCE_ENTERED_BY),
  digest,
};

const EFFECT = {
  device_id: id,
  device_label: label,
  capability: oneOf(DEVICE_CAPABILITIES),
  folder_id: matching(ITEM_ID),
  origin: matching(ORIGIN),
  app_id: matching(ITEM_ID),
  relative_path: text(1024),
  relative_path_digest: digest,
  command_id: digest,
  generation: count,
  execution_id: id,
  task_run_id: id,
  job_id: id,
  code,
};

const CONFIRMATION = {
  confirmation_id: id,
  command_id: digest,
  binding_hash: digest,
  device_id: id,
  execution_id: id,
  task_run_id: id,
  job_id: id,
};

const LOCAL = {
  backup_id: matching(ITEM_ID),
  size_bytes_bucket: oneOf(["<1KB", "<1MB", "<10MB", "<100MB", ">=100MB"]),
  engine_version: matching(VERSION),
};

export const DEVICE_DETAIL_CHECKS: Readonly<Record<string, Readonly<Record<string, DetailCheck>>>> =
  {
    "device_runner.enrolled": RUNNER,
    "device_runner.revoked": RUNNER,
    "device.folder_allowed": ALLOWANCE,
    "device.folder_removed": ALLOWANCE,
    "device.site_allowed": ALLOWANCE,
    "device.site_removed": ALLOWANCE,
    "device.app_allowed": ALLOWANCE,
    "device.app_removed": ALLOWANCE,
    "device.keep_out_added": ALLOWANCE,
    "device.keep_out_removed": ALLOWANCE,
    "device_command.completed": EFFECT,
    "device_command.refused": EFFECT,
    "device_command.lost": EFFECT,
    "device.stop": EFFECT,
    "device.screenshot_viewed": EFFECT,
    "local_confirmation.granted": CONFIRMATION,
    "local_confirmation.declined": CONFIRMATION,
    "local_mode.initialized": LOCAL,
    "local_backup.created": LOCAL,
    "local_backup.restored": LOCAL,
    "workspace.moved_to_server": LOCAL,
  };

export function deviceDetails(entry: AuditEntry): Record<string, Detail> | null {
  if (!Object.hasOwn(DEVICE_DETAIL_CHECKS, entry.action)) return null;
  const checks = DEVICE_DETAIL_CHECKS[entry.action] ?? {};
  const details: Record<string, Detail> = {};
  for (const [field, check] of Object.entries(checks)) {
    if (!Object.hasOwn(entry.metadata, field)) continue;
    const value = check(entry.metadata[field]);
    if (value !== undefined) details[field] = value;
  }
  return details;
}
