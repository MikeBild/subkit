// `extract` flow — unstructured sample → canonical schema + data.
// Thin wrapper around `core/invoke.ts`.

import { z } from "zod";

import type { Db } from "../../db/client.ts";
import { invoke } from "../core/invoke.ts";
import type { EnhancedPrompt } from "../types.ts";

const ExtractEnvelopeSchema = z.object({
  schema: z.unknown(),
  data: z.unknown(),
});

type ExtractEnvelope = z.infer<typeof ExtractEnvelopeSchema>;

export interface ExtractParams {
  tenant_id: string;
  sample: string;
  hint?: string | undefined;
}

export interface ExtractResult {
  schema: unknown;
  data: unknown;
  raw_text: string;
  tokens: EnhancedPrompt["token_counts"];
  model_used: string;
  fell_back: boolean;
  /**
   * Roundtrip status — does the inferred `schema` actually accept the
   * inferred `data`? `ok` when the structural check passes, `fail`
   * when a recognisable JSON-Schema shape rejects the sample, and
   * `unverified` when the schema's shape is unrecognised (caller
   * decides whether to trust it).
   */
  roundtrip_status: "ok" | "fail" | "unverified";
  /** Specific issues when `roundtrip_status === "fail"`. */
  roundtrip_issues: string[];
}

interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
}

/**
 * Minimal structural check: does the inferred JSON-Schema-like
 * `schema` accept its own `data`? Catches the common LLM shapes
 * without pulling Ajv into the engine bundle. Returns `unverified`
 * when the shape is unrecognised so the caller can decide.
 */
export function validateExtractRoundtrip(
  schema: unknown,
  data: unknown,
): { status: "ok" | "fail" | "unverified"; issues: string[] } {
  const issues: string[] = [];
  if (!schema || typeof schema !== "object") return { status: "unverified", issues };
  const s = schema as JsonSchemaLike;
  if (typeof s.type !== "string") return { status: "unverified", issues };
  switch (s.type) {
    case "object": {
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        issues.push(
          `schema.type=object but data is ${data === null ? "null" : Array.isArray(data) ? "array" : typeof data}`,
        );
        break;
      }
      const dataObj = data as Record<string, unknown>;
      for (const req of s.required ?? []) {
        if (!(req in dataObj)) issues.push(`required field "${req}" missing from data`);
      }
      break;
    }
    case "array":
      if (!Array.isArray(data)) issues.push(`schema.type=array but data is ${typeof data}`);
      break;
    case "string":
      if (typeof data !== "string") issues.push(`schema.type=string but data is ${typeof data}`);
      break;
    case "number":
    case "integer":
      if (typeof data !== "number") issues.push(`schema.type=${s.type} but data is ${typeof data}`);
      break;
    case "boolean":
      if (typeof data !== "boolean") issues.push(`schema.type=boolean but data is ${typeof data}`);
      break;
    case "null":
      if (data !== null) issues.push(`schema.type=null but data is non-null`);
      break;
    default:
      return { status: "unverified", issues };
  }
  return { status: issues.length > 0 ? "fail" : "ok", issues };
}

export async function runExtractFlow(p: ExtractParams, exec?: Db): Promise<ExtractResult> {
  const userContent = p.hint ? `Hint: ${p.hint}\n\nSample:\n${p.sample}` : `Sample:\n${p.sample}`;
  const r = await invoke<ExtractEnvelope>(
    {
      flow: "extract",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: userContent }],
      schema: ExtractEnvelopeSchema,
    },
    exec,
  );
  const obj = r.object ?? { schema: null, data: null };
  const roundtrip = validateExtractRoundtrip(obj.schema, obj.data);
  return {
    schema: obj.schema ?? null,
    data: obj.data ?? null,
    raw_text: r.text,
    tokens: r.assembled.prompt.token_counts,
    model_used: r.model_used,
    fell_back: r.fell_back,
    roundtrip_status: roundtrip.status,
    roundtrip_issues: roundtrip.issues,
  };
}
