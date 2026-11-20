import type { DecryptedCredential } from "../credentials/types.ts";
import { scrubUrl } from "./egress.ts";

export const RECORDED_URL_MASK = "***";

export function connectorMaskedQueryKeys(
  config: unknown,
  credential: DecryptedCredential | null | undefined,
): string[] {
  const declared = (config as { static_query?: unknown } | null | undefined)?.static_query;
  return [
    ...(credential?.mode === "query" ? Object.keys(credential.query) : []),
    ...(declared ? Object.keys(declared) : []),
  ];
}

export function recordedUrl(url: string | URL, maskedQueryKeys: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    return String(url).split("?")[0] ?? "";
  }
  for (const key of new Set(maskedQueryKeys))
    if (parsed.searchParams.has(key)) parsed.searchParams.set(key, RECORDED_URL_MASK);
  return scrubUrl(parsed);
}
