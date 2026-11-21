import type { DeviceSubBoundary } from "@shared/device/boundary.ts";
import type { DeviceCommand } from "@shared/device/protocol.ts";

export interface DownloadWrite {
  readonly command: DeviceCommand;
  readonly folder_id: string;
  readonly name: string;
  readonly bytes: Uint8Array;
}

function filesBoundary(args: unknown): DeviceSubBoundary | null {
  const boundary = (args as { boundary?: DeviceSubBoundary } | null)?.boundary;
  return boundary ? { ...boundary, capability: "files" } : null;
}

export function downloadWriteCommand(input: DownloadWrite): DeviceCommand {
  const boundary = filesBoundary(input.command.args);
  return {
    ...input.command,
    kind: "files.write",
    args: {
      target: { folder_id: input.folder_id, path: input.name },
      content: { encoding: "base64", data: Buffer.from(input.bytes).toString("base64") },
      replace: false,
      ...(boundary ? { boundary } : {}),
    },
  };
}
