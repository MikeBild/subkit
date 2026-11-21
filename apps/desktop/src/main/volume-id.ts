import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { mountPointOf, volumeIdentity, volumeUuidOf } from "../shared/local/volume-id.ts";

const DF = "/bin/df";
const DISKUTIL = "/usr/sbin/diskutil";

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { env: {}, timeout: 5_000 }, (error, stdout) =>
      resolve(error ? null : String(stdout)),
    );
  });
}

export async function volumeUuid(path: string): Promise<string | null> {
  const df = await run(DF, ["-P", path]);
  const mount = df ? mountPointOf(df) : null;
  if (!mount) return null;
  const plist = await run(DISKUTIL, ["info", "-plist", mount]);
  return plist ? volumeUuidOf(plist) : null;
}

export async function volumeIdOf(path: string): Promise<string> {
  return volumeIdentity(await volumeUuid(path), statSync(path).dev);
}
