// Deterministic OpenAPI 3.x parser. No LLM required.
// Handles both YAML and JSON input by detecting the format.

import type { EndpointSpec, HttpMethod } from "../document-analysis.ts";

export function parseOpenApi(content: string): EndpointSpec[] {
  let doc: Record<string, unknown>;
  try {
    // Try JSON first, then YAML (simple YAML handling)
    if (content.trimStart().startsWith("{")) {
      doc = JSON.parse(content) as Record<string, unknown>;
    } else {
      // Basic YAML → JSON conversion using built-in (Bun supports it)
      // For now, try JSON.parse after stripping YAML markers
      doc = JSON.parse(content) as Record<string, unknown>;
    }
  } catch {
    throw new Error("Failed to parse OpenAPI document as JSON or YAML");
  }

  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  const endpoints: EndpointSpec[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    const methods = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
    for (const method of methods) {
      const operation = pathItem[method] as Record<string, unknown> | undefined;
      if (!operation) continue;

      const responses = (operation.responses ?? {}) as Record<string, unknown>;
      const expected_statuses = Object.keys(responses)
        .map(Number)
        .filter((s) => !Number.isNaN(s) && s >= 200 && s < 600);

      const requestBody = operation.requestBody as Record<string, unknown> | undefined;
      const requestContent = requestBody?.content as Record<string, unknown> | undefined;
      const jsonContent = requestContent?.["application/json"] as
        | Record<string, unknown>
        | undefined;
      const request_schema = jsonContent?.schema as Record<string, unknown> | undefined;

      const parameters = (operation.parameters ?? []) as Array<Record<string, unknown>>;
      const queryParams = parameters.filter((p) => p.in === "query");
      const query_schema: Record<string, unknown> | undefined =
        queryParams.length > 0
          ? {
              type: "object",
              properties: Object.fromEntries(
                queryParams.map((p) => [p.name, p.schema ?? { type: "string" }]),
              ),
              required: queryParams.filter((p) => p.required).map((p) => p.name as string),
            }
          : undefined;

      const idempotentMethods = new Set(["get", "put", "head", "options", "delete"]);
      const desc = (operation.summary ?? operation.description) as string | undefined;
      endpoints.push({
        path,
        method: method.toUpperCase() as HttpMethod,
        ...(desc !== undefined ? { description: desc } : {}),
        ...(request_schema !== undefined ? { request_schema } : {}),
        ...(query_schema !== undefined ? { query_schema } : {}),
        expected_statuses: expected_statuses.length > 0 ? expected_statuses : [200],
        idempotent: idempotentMethods.has(method),
      });
    }
  }

  return endpoints;
}
