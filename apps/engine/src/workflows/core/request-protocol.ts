import type { RequestProtocol } from "@shared/request-protocol.ts";
import { workflowJsonDigest } from "../canonical-json.ts";

export {
  REQUEST_PROTOCOLS,
  type RequestProtocol,
  type RequestProtocolDriver,
  requestProtocol,
  requestProtocolDriver,
} from "@shared/request-protocol.ts";

export interface RequestProtocolChange {
  step_id: string;
  protocol: Exclude<RequestProtocol, "http">;
}

export interface StoredProtocolRewrite {
  changed: boolean;
  dag: unknown;
  changes: RequestProtocolChange[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasBlock(step: Record<string, unknown>, block: string): boolean {
  return step[block] !== undefined && step[block] !== null;
}

export function derivedRequestProtocol(step: Record<string, unknown>): RequestProtocol {
  if (hasBlock(step, "mcp")) return "mcp";
  if (hasBlock(step, "sql")) return "sql";
  if (hasBlock(step, "graphql")) return "graphql";
  if (hasBlock(step, "s3")) return "s3";
  return "http";
}

export function rewriteStoredRequestProtocols(dag: unknown): StoredProtocolRewrite {
  const steps = isRecord(dag) && Array.isArray(dag.steps) ? dag.steps : null;
  if (!steps) return { changed: false, dag, changes: [] };
  const changes: RequestProtocolChange[] = [];
  const out = steps.map((step: unknown) => {
    if (!isRecord(step) || step.kind !== "request" || step.protocol !== undefined) return step;
    const protocol = derivedRequestProtocol(step);
    if (protocol === "http") return step;
    changes.push({ step_id: typeof step.id === "string" ? step.id : "", protocol });
    return { ...step, protocol };
  });
  if (changes.length === 0) return { changed: false, dag, changes };
  return { changed: true, dag: { ...(dag as Record<string, unknown>), steps: out }, changes };
}

export function requestDigestView(step: unknown): unknown {
  if (!isRecord(step) || !("protocol" in step)) return step;
  const { protocol: _protocol, ...rest } = step;
  return rest;
}

export function definitionDigestView(definition: unknown): unknown {
  if (!isRecord(definition) || !Array.isArray(definition.steps)) return definition;
  return { ...definition, steps: definition.steps.map(requestDigestView) };
}

export function requestDigest(step: unknown): string {
  return workflowJsonDigest(requestDigestView(step));
}

export function definitionDigest(definition: unknown): string {
  return workflowJsonDigest(definitionDigestView(definition));
}
