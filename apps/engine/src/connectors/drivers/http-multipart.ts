import { createHash } from "node:crypto";

export function multipartObservationHeaders(headers: Record<string, string>) {
  return Object.fromEntries([
    ...Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type"),
    ["content-type", "multipart/form-data"],
  ]);
}

export async function prepareMultipartBody(form: FormData) {
  const entries = [...form.entries()] as Array<[string, string | File]>;
  const stable = new FormData();
  for (const [name, value] of entries) {
    if (typeof value === "string") stable.append(name, value);
    else stable.append(name, value, value.name);
  }
  const parts = [];
  for (const [name, value] of entries) {
    if (typeof value === "string") parts.push({ name, value });
    else {
      const bytes = await value.arrayBuffer();
      parts.push({
        name,
        filename: value.name,
        content_type: value.type,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
      });
    }
  }
  const encoded = new Request("https://multipart.invalid", { method: "POST", body: stable });
  const contentType = encoded.headers.get("content-type");
  if (!contentType) throw new Error("Multipart content type unavailable");
  const body = await encoded.arrayBuffer();
  return {
    body,
    contentType,
    observation: {
      body: { parts },
      body_encoding: "multipart" as const,
      body_bytes: body.byteLength,
    },
  };
}
