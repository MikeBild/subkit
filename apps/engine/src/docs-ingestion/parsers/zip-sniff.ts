const ZIP_LOCAL_HEADER_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const SCAN_LIMIT_BYTES = 64 * 1024;

export function hasZipEntryPrefix(buffer: Buffer, prefix: string): boolean {
  if (buffer.length < ZIP_LOCAL_HEADER_SIG.length) return false;
  if (!buffer.subarray(0, 4).equals(ZIP_LOCAL_HEADER_SIG)) return false;

  const limit = Math.min(buffer.length, SCAN_LIMIT_BYTES);
  const needle = Buffer.from(prefix, "utf8");

  let offset = 0;
  while (offset + 30 <= limit) {
    if (!buffer.subarray(offset, offset + 4).equals(ZIP_LOCAL_HEADER_SIG)) {
      break;
    }
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > limit) break;
    const entryName = buffer.subarray(nameStart, nameEnd);
    if (entryName.length >= needle.length && entryName.subarray(0, needle.length).equals(needle)) {
      return true;
    }
    offset = nameEnd + extraLen + compressedSize;
  }
  return false;
}
