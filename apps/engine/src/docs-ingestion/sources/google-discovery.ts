// Google API Discovery source normalizer.

import {
  type GoogleDiscoveryObject,
  googleDiscoveryBaseUrl,
  listGoogleDiscoveryMethods,
  parseGoogleDiscoveryDocument,
} from "../../llm/flows/document-parsers/google-discovery.ts";
import { assertPageSize, consumeBytes, recordSpecFetched } from "../budgets.ts";
import { byteLen } from "../chunker.ts";
import type { BudgetState, RawChunk } from "../types.ts";

export interface GoogleDiscoveryIngestResult {
  uri: string;
  raw_bytes: number;
  chunks: RawChunk[];
}

function asObject(value: unknown): GoogleDiscoveryObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as GoogleDiscoveryObject)
    : {};
}

export async function fetchGoogleDiscovery(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ body: string; bytes: number; parsed: GoogleDiscoveryObject }> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`google discovery fetch failed: ${res.status}`);
  const body = await res.text();
  const bytes = byteLen(body);
  assertPageSize(bytes);
  return { body, bytes, parsed: parseGoogleDiscoveryDocument(body) };
}

export function chunkGoogleDiscovery(spec: GoogleDiscoveryObject): RawChunk[] {
  const title = typeof spec.title === "string" ? spec.title : "Google API";
  const version = typeof spec.version === "string" ? spec.version : "unknown";
  const description = typeof spec.description === "string" ? spec.description : "";
  const baseUrl = googleDiscoveryBaseUrl(spec);
  const out: RawChunk[] = [
    {
      title: `${title} (${version}) — overview`,
      path: "info",
      content: [
        `# ${title}`,
        `version: ${version}`,
        baseUrl ? `server: ${baseUrl}` : "",
        description,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  for (const entry of listGoogleDiscoveryMethods(spec)) {
    const method = entry.method;
    const httpMethod = typeof method.httpMethod === "string" ? method.httpMethod : "HTTP";
    const rawPath =
      typeof method.flatPath === "string"
        ? method.flatPath
        : typeof method.path === "string"
          ? method.path
          : "";
    const description = typeof method.description === "string" ? method.description : "";
    const scopes = Array.isArray(method.scopes) ? method.scopes.join(", ") : "";
    const parameters = Object.entries(asObject(method.parameters))
      .map(([name, raw]) => {
        const parameter = asObject(raw);
        const location = typeof parameter.location === "string" ? parameter.location : "unknown";
        const details = typeof parameter.description === "string" ? parameter.description : "";
        return `- ${location}.${name}: ${details}`;
      })
      .join("\n");
    const heading = `${httpMethod} /${rawPath.replace(/^\//, "")}`;
    out.push({
      title: `${heading} — ${entry.id}`,
      path: `methods.${entry.id}`,
      content: [
        `# ${heading}`,
        `methodId: ${entry.id}`,
        description,
        scopes ? `scopes: ${scopes}` : "",
        parameters ? `## parameters\n${parameters}` : "",
        method.request ? `request: ${JSON.stringify(method.request)}` : "",
        method.response ? `response: ${JSON.stringify(method.response)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  }

  for (const [name, rawSchema] of Object.entries(asObject(spec.schemas))) {
    if (typeof rawSchema !== "object" || rawSchema === null) continue;
    out.push({
      title: `schema: ${name}`,
      path: `schemas.${name}`,
      content: `# schema: ${name}\n\n\`\`\`json\n${JSON.stringify(rawSchema, null, 2)}\n\`\`\``,
    });
  }

  return out;
}

export async function ingestGoogleDiscoveryUrl(
  url: string,
  state: BudgetState,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleDiscoveryIngestResult> {
  const fetched = await fetchGoogleDiscovery(url, fetchImpl);
  consumeBytes(state, fetched.bytes);
  recordSpecFetched(state);
  return {
    uri: url,
    raw_bytes: fetched.bytes,
    chunks: chunkGoogleDiscovery(fetched.parsed),
  };
}
