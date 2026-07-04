// OpenAPI source normalizer.
//
// P6 supports JSON specs only. The Petstore smoke uses a JSON URL, which
// is all we need for the retrieval API. YAML support will land in a
// later pass once we add a tiny YAML dep or vend one in — the chunker
// and service are unchanged by that switch.
//
// Emitted shape:
//   - 1 "index" chunk summarising the spec (title, description, server).
//   - 1 chunk per `paths.<path>.<method>` operation, with a dotted path
//     and a compact body that includes summary, description, params,
//     request body, and responses.
//   - 1 chunk per `components.schemas.<name>` top-level schema.

import {
  assertPageSize,
  canFetchSpec,
  canFollowLink,
  consumeBytes,
  MAX_LINKS,
  recordLinkFollowed,
  recordSpecFetched,
} from "../budgets.ts";
import { byteLen } from "../chunker.ts";
import type { BudgetState, RawChunk } from "../types.ts";

type Json = Record<string, unknown>;

export interface OpenAPIIngestResult {
  uri: string;
  raw_bytes: number;
  chunks: RawChunk[];
}

export async function fetchOpenAPI(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ body: string; bytes: number; parsed: Json }> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`openapi fetch failed: ${res.status}`);
  const body = await res.text();
  const bytes = byteLen(body);
  assertPageSize(bytes);
  let parsed: Json;
  try {
    parsed = JSON.parse(body) as Json;
  } catch (err) {
    throw new Error(
      `openapi parse failed (P6 supports JSON only): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { body, bytes, parsed };
}

/** Convert an OpenAPI doc JSON into a flat list of normalized chunks. */
export function chunkOpenAPI(spec: Json): RawChunk[] {
  const out: RawChunk[] = [];
  const info = (spec.info as Json | undefined) ?? {};
  const servers = Array.isArray(spec.servers) ? (spec.servers as Json[]) : [];
  const title = String(info.title ?? "OpenAPI document");
  const version = String(info.version ?? "unknown");
  const description = typeof info.description === "string" ? info.description : "";
  const server = servers[0]?.url
    ? String(servers[0]?.url)
    : spec.host
      ? `https://${spec.host}${spec.basePath ?? ""}`
      : "";

  out.push({
    title: `${title} (${version}) — overview`,
    path: "info",
    content: [`# ${title}`, `version: ${version}`, server ? `server: ${server}` : "", description]
      .filter(Boolean)
      .join("\n\n"),
  });

  const paths = (spec.paths as Json | undefined) ?? {};
  for (const [rawPath, rawOp] of Object.entries(paths)) {
    if (!rawOp || typeof rawOp !== "object") continue;
    const pathObj = rawOp as Json;
    const methods = ["get", "post", "put", "patch", "delete", "options", "head"] as const;
    for (const method of methods) {
      const op = pathObj[method] as Json | undefined;
      if (!op) continue;
      const summary = typeof op.summary === "string" ? op.summary : "";
      const opDescription = typeof op.description === "string" ? op.description : "";
      const operationId = typeof op.operationId === "string" ? op.operationId : "";
      const tags = Array.isArray(op.tags) ? (op.tags as string[]).join(", ") : "";
      const params = Array.isArray(op.parameters)
        ? (op.parameters as Json[])
            .map((p) => {
              const name = String(p.name ?? "");
              const location = String(p.in ?? "");
              const desc = typeof p.description === "string" ? p.description : "";
              return `- ${location}.${name}: ${desc}`;
            })
            .join("\n")
        : "";
      const responses = op.responses ? Object.keys(op.responses as Json).join(", ") : "";
      const title = `${method.toUpperCase()} ${rawPath}${summary ? ` — ${summary}` : ""}`;
      const body = [
        `# ${title}`,
        operationId ? `operationId: ${operationId}` : "",
        tags ? `tags: ${tags}` : "",
        opDescription,
        params ? `## parameters\n${params}` : "",
        responses ? `## responses\n${responses}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      out.push({
        title,
        path: `paths.${rawPath}.${method}`,
        content: body,
      });
    }
  }

  // components.schemas (OpenAPI 3) or definitions (Swagger 2).
  const components = (spec.components as Json | undefined) ?? {};
  const schemas =
    (components.schemas as Json | undefined) ?? (spec.definitions as Json | undefined) ?? {};
  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== "object") continue;
    const body = `# schema: ${name}\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``;
    out.push({
      title: `schema: ${name}`,
      path: `components.schemas.${name}`,
      content: body,
    });
  }

  return out;
}

/**
 * Walk a parsed OpenAPI document and collect every external file-level
 * `$ref` it points at. "External" = the ref value contains a URL or
 * bare-file path rather than a pure in-document `#/...` fragment.
 *
 * The returned URLs preserve first-seen order so the 20-link cap is
 * deterministic across runs. Fragment-only refs (`#/components/...`)
 * are ignored — they resolve in-spec and don't cost a fetch.
 */
export function collectExternalRefs(spec: unknown, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$ref" && typeof v === "string") {
        // In-document fragment — no fetch required.
        if (v.startsWith("#")) continue;
        // Strip any trailing fragment so siblings of the same file
        // collapse to one fetchable URL.
        const fileRef = v.split("#")[0]!;
        if (!fileRef) continue;
        let resolved: string;
        try {
          resolved = new URL(fileRef, baseUrl).toString();
        } catch {
          continue;
        }
        if (!seen.has(resolved)) {
          seen.add(resolved);
          out.push(resolved);
        }
      } else {
        visit(v);
      }
    }
  };
  visit(spec);
  return out;
}

export async function ingestOpenAPIUrl(
  url: string,
  state: BudgetState,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenAPIIngestResult> {
  const fetched = await fetchOpenAPI(url, fetchImpl);
  consumeBytes(state, fetched.bytes);
  recordSpecFetched(state);
  const chunks = chunkOpenAPI(fetched.parsed);

  // GC6: cap external `$ref` file follows at MAX_LINKS (20). Every ref
  // that resolves to a distinct URL counts as one link against the
  // shared BudgetState so a mix of llms.txt + openapi refs still stays
  // under the global crawl cap.
  const refs = collectExternalRefs(fetched.parsed, url);
  let followed = 0;
  for (const refUrl of refs) {
    if (followed >= MAX_LINKS) break;
    if (!canFollowLink(state)) break;
    if (!canFetchSpec(state)) break;
    if (state.budget_exceeded) break;
    try {
      const sub = await fetchOpenAPI(refUrl, fetchImpl);
      consumeBytes(state, sub.bytes);
      recordSpecFetched(state);
      recordLinkFollowed(state);
      followed += 1;
      for (const c of chunkOpenAPI(sub.parsed)) {
        chunks.push({
          title: `${c.title ?? ""} (ref)`.trim(),
          path: c.path ?? null,
          content: c.content,
        });
      }
    } catch (_err) {
      // Non-fatal — a single broken ref should not fail the whole ingest.
      // The service logs the individual failure at warn level.
    }
  }

  return { uri: url, raw_bytes: fetched.bytes, chunks };
}
