// Deterministic Postman Collection v2.1 parser. No LLM required.

import type { EndpointSpec, HttpMethod } from "../document-analysis.ts";

interface PostmanItem {
  name?: string;
  request?: {
    method?: string;
    url?: { raw?: string; path?: string[] };
    header?: Array<{ key: string; value: string }>;
    body?: { mode?: string; raw?: string };
  };
  item?: PostmanItem[];
}

function flattenItems(items: PostmanItem[]): PostmanItem[] {
  const result: PostmanItem[] = [];
  for (const item of items) {
    if (item.item) {
      result.push(...flattenItems(item.item));
    } else if (item.request) {
      result.push(item);
    }
  }
  return result;
}

export function parsePostman(content: string): EndpointSpec[] {
  const doc = JSON.parse(content) as { item?: PostmanItem[] };
  const items = flattenItems(doc.item ?? []);
  const endpoints: EndpointSpec[] = [];

  for (const item of items) {
    const req = item.request;
    if (!req) continue;
    const method = (req.method ?? "GET").toUpperCase() as HttpMethod;
    const urlParts = req.url?.path ?? [];
    const path = `/${urlParts.join("/")}`;

    let request_schema: Record<string, unknown> | undefined;
    if (req.body?.mode === "raw" && req.body.raw) {
      try {
        const parsed = JSON.parse(req.body.raw) as unknown;
        if (typeof parsed === "object" && parsed !== null) {
          request_schema = {
            type: "object",
            properties: Object.fromEntries(
              Object.keys(parsed as Record<string, unknown>).map((k) => [k, { type: "string" }]),
            ),
          };
        }
      } catch {
        // non-JSON body — skip schema inference
      }
    }

    const idempotentMethods = new Set(["GET", "PUT", "HEAD", "OPTIONS", "DELETE"]);
    endpoints.push({
      path,
      method,
      ...(item.name !== undefined ? { description: item.name } : {}),
      ...(request_schema !== undefined ? { request_schema } : {}),
      expected_statuses: [200],
      idempotent: idempotentMethods.has(method),
    });
  }

  return endpoints;
}
