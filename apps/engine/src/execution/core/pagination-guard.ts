import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

export function pageFingerprint(body: unknown): string {
  const serialized = JSON.stringify(canonical(body)) ?? "undefined";
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export type RepeatVerdict = "new" | "repeated";

export function repeatVerdict(seen: ReadonlySet<string>, fingerprint: string): RepeatVerdict {
  return seen.has(fingerprint) ? "repeated" : "new";
}
