export const INSTALLATION_FILE_LIMIT = 5 * 1024 * 1024;
const INSTALLATION_INPUT_LIMIT = 25 * 1024 * 1024;
export const INSTALLATION_FILE_COUNT = 10;
const INSTALLATION_TEXT_LIMIT = 2_000_000;

const FILE_TYPES = new Map([
  ["txt", "text/plain"],
  ["md", "text/plain"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["pdf", "application/pdf"],
]);

export interface InstallationIncoming {
  title: string;
  text: string;
  url: string;
  files: File[];
}

export function incomingFileType(file: Pick<File, "name" | "type">): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const expected = FILE_TYPES.get(extension);
  if (!expected) return null;
  const mime = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime && mime !== expected && !(extension === "md" && mime === "text/markdown")) return null;
  return expected;
}

export function validateInstallationIncoming(value: InstallationIncoming): void {
  if (
    value.title.length > 1000 ||
    value.text.length > INSTALLATION_TEXT_LIMIT ||
    value.url.length > 8192
  )
    throw new Error("incoming_too_large");
  if (value.url) {
    const url = new URL(value.url);
    if (!(["https:", "http:"] as string[]).includes(url.protocol) || url.username || url.password)
      throw new Error("incoming_invalid_url");
  }
  if (value.files.length > INSTALLATION_FILE_COUNT) throw new Error("incoming_too_many_files");
  let bytes = new TextEncoder().encode(value.text).byteLength;
  for (const file of value.files) {
    if (!file.size || file.size > INSTALLATION_FILE_LIMIT)
      throw new Error("incoming_file_too_large");
    if (!incomingFileType(file)) throw new Error("incoming_file_type");
    bytes += file.size;
  }
  if (bytes > INSTALLATION_INPUT_LIMIT) throw new Error("incoming_too_large");
  if (!value.files.length && !value.text.trim() && !value.url) throw new Error("incoming_empty");
}

export function incomingFromClipboard(text: string): InstallationIncoming {
  const value = { title: "", text, url: "", files: [] };
  validateInstallationIncoming(value);
  return value;
}

export function incomingSourceUrl(value: string, fallback: string): string {
  if (!value) return fallback;
  const url = new URL(value);
  if (!(["https:", "http:"] as string[]).includes(url.protocol) || url.username || url.password)
    throw new Error("incoming_invalid_url");
  return url.href;
}
