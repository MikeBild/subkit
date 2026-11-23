import { createHash } from "node:crypto";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function coveredArgumentsDigest(args: unknown): string {
  return createHash("sha256").update(canonical(args)).digest("hex");
}

export type CoveredArgumentsVerdict = "unbound" | "same" | "changed";

export function coveredArgumentsVerdict(
  covered_digest: string | null | undefined,
  executed: unknown,
): CoveredArgumentsVerdict {
  if (covered_digest === null || covered_digest === undefined) return "unbound";
  return coveredArgumentsDigest(executed) === covered_digest ? "same" : "changed";
}
