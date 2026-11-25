export const DESKTOP_CHECKSUMS = "SHA256SUMS-desktop";
export const RELEASE_REPOSITORY = "MikeBild/subkit";

export type ManifestVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "signature_invalid" | "not_listed" | "checksum_mismatch";
    };

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match?.[1] && match[2]) entries.set(match[2].trim(), match[1].toLowerCase());
  }
  return entries;
}

export function judgeDownload(input: {
  readonly signatureValid: boolean;
  readonly manifest: string;
  readonly fileName: string;
  readonly sha256: string;
}): ManifestVerdict {
  if (!input.signatureValid) return { ok: false, reason: "signature_invalid" };
  const expected = parseChecksums(input.manifest).get(input.fileName);
  if (!expected) return { ok: false, reason: "not_listed" };
  return expected === input.sha256.toLowerCase()
    ? { ok: true }
    : { ok: false, reason: "checksum_mismatch" };
}

export const checksumUrls = (repository: string, version: string) => {
  const base = `https://github.com/${repository}/releases/download/v${version}`;
  return {
    manifest: `${base}/${DESKTOP_CHECKSUMS}`,
    signature: `${base}/${DESKTOP_CHECKSUMS}.sig`,
  };
};
