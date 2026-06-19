// Lightweight ZIP central-directory sniffer used by the DOCX / XLSX /
// PPTX detectors.
//
// Office Open XML files are ZIPs; we identify them by checking the
// signature of the local-file-header records at the start of the
// archive. A full ZIP parse would require yauzl and a worker; here we
// only need to know whether at least one entry's filename starts with a
// well-known prefix (`word/`, `xl/`, `ppt/`).
//
// Limits scan to the first 64 KiB so a 100 MB upload doesn't slow the
// detection layer. Office documents always carry their content-type
// part in the first few KiB; the prefix we look for will appear well
// before the cutoff for any well-formed file.

const ZIP_LOCAL_HEADER_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
const SCAN_LIMIT_BYTES = 64 * 1024;

/** Return true when the ZIP central directory contains at least one
 *  local-file entry whose filename starts with `prefix`. */
export function hasZipEntryPrefix(buffer: Buffer, prefix: string): boolean {
  if (buffer.length < ZIP_LOCAL_HEADER_SIG.length) return false;
  if (!buffer.subarray(0, 4).equals(ZIP_LOCAL_HEADER_SIG)) return false;

  const limit = Math.min(buffer.length, SCAN_LIMIT_BYTES);
  const needle = Buffer.from(prefix, "utf8");

  let offset = 0;
  while (offset + 30 <= limit) {
    if (!buffer.subarray(offset, offset + 4).equals(ZIP_LOCAL_HEADER_SIG)) {
      // Either malformed or we've walked past the local headers; bail.
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
