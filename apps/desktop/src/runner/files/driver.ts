import type { DeviceSubBoundary } from "@shared/device/boundary.ts";
import {
  FilesImportArgsSchema,
  FilesListArgsSchema,
  FilesMkdirArgsSchema,
  FilesMoveArgsSchema,
  FilesReadTextArgsSchema,
  FilesTrashArgsSchema,
  FilesWriteArgsSchema,
  type FileTarget,
} from "@shared/device/files.ts";
import type { DeviceCommand, DeviceCommandKind, DeviceResult } from "@shared/device/protocol.ts";
import {
  failed,
  type Grant,
  grantTarget,
  modeOf,
  refused,
  requiredAccess,
} from "../../shared/local/files-policy.ts";
import type { DeviceAdapter } from "../adapter.ts";
import { moveItems, trashItems } from "./batch.ts";
import { type FilesDeps, type OpContext, opContext } from "./context.ts";
import { importFile, listFolder, readText } from "./read.ts";
import { DEFAULT_POLICY, DEV_VOLUME_ID } from "./resolve.ts";
import { makeFolder, writeFile } from "./write.ts";

export const FILES_KINDS: readonly DeviceCommandKind[] = [
  "files.list",
  "files.read_text",
  "files.import",
  "files.write",
  "files.mkdir",
  "files.move",
  "files.trash",
];

function grantFor(
  context: OpContext,
  boundary: DeviceSubBoundary | undefined,
): (target: FileTarget) => Grant {
  return (target) =>
    grantTarget({
      mode: modeOf(context.command),
      device_id: context.deps.device_id,
      snapshot: context.resolve.snapshot,
      boundary,
      target,
      need: requiredAccess(context.command.kind),
    });
}

async function single(
  context: OpContext,
  boundary: DeviceSubBoundary | undefined,
  target: FileTarget,
  run: (folder: Grant & { ok: true }) => Promise<DeviceResult>,
): Promise<DeviceResult> {
  const grant = grantFor(context, boundary)(target);
  return grant.ok ? run(grant) : refused(grant.code);
}

async function dispatch(context: OpContext): Promise<DeviceResult> {
  const { kind, args } = context.command;
  switch (kind) {
    case "files.list": {
      const parsed = FilesListArgsSchema.safeParse(args);
      if (!parsed.success) return failed("bad_args");
      const { target, boundary } = parsed.data;
      return single(context, boundary, target, (grant) =>
        listFolder(context, target, grant.folder),
      );
    }
    case "files.read_text": {
      const parsed = FilesReadTextArgsSchema.safeParse(args);
      if (!parsed.success) return failed("bad_args");
      const { target, boundary } = parsed.data;
      return single(context, boundary, target, (grant) => readText(context, target, grant.folder));
    }
    case "files.import": {
      const parsed = FilesImportArgsSchema.safeParse(args);
      if (!parsed.success) return failed("bad_args");
      const { target, boundary, name } = parsed.data;
      return single(context, boundary, target, (grant) =>
        importFile(context, target, grant.folder, name),
      );
    }
    case "files.write": {
      const parsed = FilesWriteArgsSchema.safeParse(args);
      if (!parsed.success) return failed("bad_args");
      const { target, boundary, content, replace } = parsed.data;
      return single(context, boundary, target, (grant) =>
        writeFile(context, target, grant.folder, content, replace),
      );
    }
    case "files.mkdir": {
      const parsed = FilesMkdirArgsSchema.safeParse(args);
      if (!parsed.success) return failed("bad_args");
      const { target, boundary } = parsed.data;
      return single(context, boundary, target, (grant) =>
        makeFolder(context, target, grant.folder),
      );
    }
    case "files.move": {
      const parsed = FilesMoveArgsSchema.safeParse(args);
      if (!parsed.success) return failed("bad_args");
      return moveItems(context, grantFor(context, parsed.data.boundary), parsed.data.items);
    }
    case "files.trash": {
      const parsed = FilesTrashArgsSchema.safeParse(args);
      if (!parsed.success) return failed("bad_args");
      return trashItems(context, grantFor(context, parsed.data.boundary), parsed.data.items);
    }
    default:
      return failed("bad_args");
  }
}

export function createFilesAdapter(deps: FilesDeps, version: string): DeviceAdapter {
  return {
    name: "files",
    version,
    kinds: FILES_KINDS,
    async execute(command: DeviceCommand, signal: AbortSignal) {
      if (signal.aborted) return { status: "stopped" };
      const resolve = {
        device_id: deps.device_id,
        snapshot: deps.snapshot(),
        policy: deps.policy ?? DEFAULT_POLICY,
        volume_id: deps.volumeId ?? DEV_VOLUME_ID,
      };
      const result = await dispatch(opContext(deps, resolve, command, signal));
      return signal.aborted && result.status !== "done" ? { status: "stopped" } : result;
    },
  };
}
