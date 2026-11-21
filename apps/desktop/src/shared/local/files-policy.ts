import type { DeviceSubBoundary, FolderAccess } from "@shared/device/boundary.ts";
import type { FileTarget } from "@shared/device/files.ts";
import type {
  DeviceCommand,
  DeviceCommandKind,
  DeviceRefusal,
  DeviceResult,
} from "@shared/device/protocol.ts";
import { ALLOW, type PolicyResult, refuse } from "@shared/local-policy/result.ts";
import { type FilesSnapshot, folderDigest, type SnapshotFolder } from "./files-allowances.ts";

export type FilesMode = "workflow" | "personal";

export function modeOf(command: Pick<DeviceCommand, "execution_id">): FilesMode {
  return command.execution_id !== null ? "workflow" : "personal";
}

const READ_KINDS: ReadonlySet<DeviceCommandKind> = new Set([
  "files.list",
  "files.read_text",
  "files.import",
]);

export function requiredAccess(kind: DeviceCommandKind): FolderAccess {
  return READ_KINDS.has(kind) ? "read" : "write";
}

function covers(have: FolderAccess, need: FolderAccess): boolean {
  return have === "write" || need === "read";
}

export function targetFitsMode(target: FileTarget, mode: FilesMode): boolean {
  return mode === "workflow" ? "folder_id" in target : "absolute" in target;
}

export interface GrantInput {
  readonly mode: FilesMode;
  readonly device_id: string;
  readonly snapshot: FilesSnapshot;
  readonly boundary: DeviceSubBoundary | undefined;
  readonly target: FileTarget;
  readonly need: FolderAccess;
}

export type Grant =
  | { readonly ok: true; readonly folder: SnapshotFolder | null }
  | { readonly ok: false; readonly code: DeviceRefusal };

export function grantTarget(input: GrantInput): Grant {
  if (!targetFitsMode(input.target, input.mode)) return { ok: false, code: "outside_boundary" };
  if (!("folder_id" in input.target)) {
    return input.snapshot.personal_enabled
      ? { ok: true, folder: null }
      : { ok: false, code: "outside_allowance" };
  }
  const boundary = input.boundary;
  if (!boundary || boundary.device_id !== input.device_id || boundary.capability !== "files") {
    return { ok: false, code: "outside_boundary" };
  }
  const folderId = input.target.folder_id;
  const bound = boundary.folders?.find((entry) => entry.folder_id === folderId);
  if (!bound || !covers(bound.access, input.need)) return { ok: false, code: "outside_boundary" };
  const local = input.snapshot.folders.find((folder) => folder.id === folderId);
  if (!local || !covers(local.access, input.need)) return { ok: false, code: "outside_allowance" };
  if (folderDigest(input.device_id, local) !== bound.root_digest) {
    return { ok: false, code: "folder_changed" };
  }
  return { ok: true, folder: local };
}

export function needsSegment(segments: number, kind: DeviceCommandKind): PolicyResult {
  return segments === 0 && requiredAccess(kind) === "write" ? refuse("outside_allowance") : ALLOW;
}

export const REFUSAL_DETAILS: Record<DeviceRefusal, string> = {
  outside_allowance: "This path is not allowed on this device. Nothing was changed.",
  outside_boundary: "This path is outside the approved boundary. Nothing was changed.",
  folder_changed: "The allowed folder was replaced. Renew the approval. Nothing was changed.",
  path_moved: "The path now leads somewhere else. Nothing was changed.",
  secret_file: "SubKit never touches secret files. Nothing was changed.",
  hidden_path: "SubKit never touches hidden files or folders. Nothing was changed.",
  executable: "SubKit never touches programs. Nothing was changed.",
  too_large: "The file is larger than the limit. Nothing was changed.",
  private_address: "Private addresses are not allowed here.",
  origin_not_allowed: "This website is not allowed.",
  credential_field: "SubKit never fills in credentials.",
  blocked_app: "This app is blocked.",
  blocked_shortcut: "This shortcut is blocked.",
  secure_focus: "A password field has focus.",
  stale: "The file changed while SubKit read it. Nothing was changed.",
  owner_active: "You are using the device right now.",
  stopped: "Stopped. Later steps won't run.",
  deadline_passed: "The command started too late and did not run.",
  permission_missing: "A permission is missing on this device.",
  trash_unavailable: "The Trash is not available. Nothing was changed.",
};

export function refused(code: DeviceRefusal): DeviceResult {
  return { status: "refused", code, detail: REFUSAL_DETAILS[code] };
}

export const FAILURE_DETAILS = {
  target_exists: "Something with this name already exists. Nothing was changed.",
  not_found: "The path does not exist. Nothing was changed.",
  not_a_file: "The path is not a file. Nothing was changed.",
  not_a_folder: "The path is not a folder. Nothing was changed.",
  not_text: "The file is not UTF-8 text.",
  bad_args: "The command arguments are not valid for this device.",
  cross_volume: "Moving between volumes is not supported. Nothing was changed.",
  import_unavailable: "Importing into SubKit Files is not available yet.",
  import_failed: "The upload into SubKit Files failed.",
  restore_failed:
    "The new version could not be placed and the previous one could not be restored; it is in the Trash.",
  io_error: "The device could not complete the file operation.",
} as const;
export type FilesFailure = keyof typeof FAILURE_DETAILS;

export function failed(code: FilesFailure): DeviceResult {
  return { status: "failed", code, detail: FAILURE_DETAILS[code] };
}

export function failureOfError(error: unknown): FilesFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return "not_found";
  if (code === "EEXIST" || code === "ENOTEMPTY") return "target_exists";
  if (code === "ENOTDIR") return "not_a_folder";
  if (code === "EISDIR") return "not_a_file";
  if (code === "EXDEV") return "cross_volume";
  return "io_error";
}
