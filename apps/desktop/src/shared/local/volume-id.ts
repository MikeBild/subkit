const DF_LINE = /^\S.*?\s+\d+\s+\d+\s+\d+\s+\d+%\s+(\/.*)$/;
const VOLUME_UUID = /<key>VolumeUUID<\/key>\s*<string>([0-9A-Fa-f-]{36})<\/string>/;

export function mountPointOf(dfOutput: string): string | null {
  const lines = dfOutput.trim().split("\n");
  const last = lines.length > 1 ? lines[lines.length - 1] : undefined;
  const match = last ? DF_LINE.exec(last) : null;
  return match ? (match[1] as string) : null;
}

export function volumeUuidOf(plist: string): string | null {
  const match = VOLUME_UUID.exec(plist);
  return match ? (match[1] as string).toUpperCase() : null;
}

export function volumeIdentity(uuid: string | null, dev: number): string {
  return uuid ? `uuid:${uuid}` : String(dev);
}
