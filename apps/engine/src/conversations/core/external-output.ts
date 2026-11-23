import { type UntrustedSource, wrapUntrusted } from "@shared/untrusted-content.ts";
import type { JSONValue } from "ai";

const WORKFLOW_TOOL_PREFIX = "wf_";
const EXTERNAL_MCP_SEPARATOR = "__";

export function externalOutputSource(
  tool: string,
  declared: UntrustedSource | undefined,
): UntrustedSource | null {
  if (tool.startsWith(WORKFLOW_TOOL_PREFIX)) return "workflow";
  if (tool.includes(EXTERNAL_MCP_SEPARATOR)) return "mcp";
  return declared ?? null;
}

export function jsonSafe(value: unknown): JSONValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JSONValue;
  } catch {
    return String(value);
  }
}

export function frameExternalResult(source: UntrustedSource | null, output: unknown): JSONValue {
  const safe = jsonSafe(output);
  if (source === null) return safe;
  if (typeof safe !== "object" || safe === null || Array.isArray(safe) || !("data" in safe))
    return wrapUntrusted(source, safe) as JSONValue;
  return { ...safe, data: wrapUntrusted(source, safe.data) as JSONValue };
}
