// Shared request/response shaping helpers for the engine client. These
// are transport-level utilities used by the `EngineClient` core in
// `../engine-client.ts` and by the per-resource method modules in this
// directory that talk to fetch directly (streamed uploads, downloads,
// raw-body extraction).

export function parseResponseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function normalizeHeaders(
  headers?: HeadersInit | Record<string, string | undefined>,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return headers.reduce<Record<string, string>>((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});
  }
  return Object.entries(headers).reduce<Record<string, string>>((acc, [key, value]) => {
    if (typeof value === "string") acc[key] = value;
    return acc;
  }, {});
}

export async function serializeFormData(form: FormData): Promise<Array<Record<string, unknown>>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      entries.push({ name, kind: "text", value });
      continue;
    }
    const fileValue = value as Blob & { name?: string };
    const entry: Record<string, unknown> = {
      name,
      kind: "file",
      file: {
        name: fileValue.name ?? null,
        type: fileValue.type,
        size: fileValue.size,
      },
    };
    if (looksTextual(fileValue.type)) {
      try {
        entry.text = await fileValue.text();
      } catch {
        entry.text = "[unreadable]";
      }
    }
    entries.push(entry);
  }
  return entries;
}

function looksTextual(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("yaml")
  );
}

export function buildQuery(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : "";
}
