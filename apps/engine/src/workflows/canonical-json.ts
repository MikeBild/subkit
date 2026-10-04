import { createHash } from "node:crypto";

export function canonicalWorkflowJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalWorkflowJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalWorkflowJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function workflowJsonDigest(value: unknown): string {
  return createHash("sha256").update(canonicalWorkflowJson(value)).digest("hex");
}
