// Deterministic HAR (HTTP Archive) parser. No LLM required.
// HAR files are captured real HTTP traffic — highest precision.

import type { EndpointSpec, HttpMethod } from "../document-analysis.ts";

interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    postData?: { mimeType?: string; text?: string };
  };
  response: {
    status: number;
    content?: { mimeType?: string; text?: string };
  };
}

export function parseHar(content: string): EndpointSpec[] {
  const doc = JSON.parse(content) as { log?: { entries?: HarEntry[] } };
  const entries = doc.log?.entries ?? [];
  const byKey = new Map<string, EndpointSpec>();

  for (const entry of entries) {
    const method = entry.request.method.toUpperCase() as HttpMethod;
    let path: string;
    try {
      const url = new URL(entry.request.url);
      path = url.pathname;
    } catch {
      continue;
    }

    const key = `${method}:${path}`;
    const existing = byKey.get(key);
    const status = entry.response.status;

    let request_schema: Record<string, unknown> | undefined;
    const postData = entry.request.postData;
    if (postData?.mimeType?.includes("json") && postData.text) {
      try {
        const parsed = JSON.parse(postData.text) as unknown;
        if (typeof parsed === "object" && parsed !== null) {
          request_schema = {
            type: "object",
            properties: Object.fromEntries(
              Object.keys(parsed as Record<string, unknown>).map((k) => [k, { type: "string" }]),
            ),
          };
        }
      } catch {
        // skip
      }
    }

    if (existing) {
      if (!existing.expected_statuses.includes(status)) {
        existing.expected_statuses.push(status);
      }
    } else {
      const idempotentMethods = new Set(["GET", "PUT", "HEAD", "OPTIONS", "DELETE"]);
      byKey.set(key, {
        path,
        method,
        ...(request_schema !== undefined ? { request_schema } : {}),
        expected_statuses: [status],
        idempotent: idempotentMethods.has(method),
      });
    }
  }

  return Array.from(byKey.values());
}
