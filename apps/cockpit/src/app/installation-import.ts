import { apiRequest } from "@/api/client";
import {
  INSTALLATION_FILE_LIMIT,
  type InstallationIncoming,
  incomingFileType,
  incomingSourceUrl,
  validateInstallationIncoming,
} from "./installation-input";

interface ImportRecord {
  requestId: string;
  file: File | null;
  title: string;
  body: string;
  sourceUrl: string;
  fileId?: string;
  itemId?: string;
}

export interface InstallationImportDraft {
  tenantId: string;
  userId: string;
  capturedAt: string;
  category?: string;
  records: ImportRecord[];
}

export async function prepareInstallationImport(
  value: InstallationIncoming,
  identity: { tenantId: string; userId: string },
): Promise<InstallationImportDraft> {
  validateInstallationIncoming(value);
  if (!value.url && new TextEncoder().encode(value.text).byteLength > INSTALLATION_FILE_LIMIT)
    throw new Error("incoming_file_too_large");
  const records: ImportRecord[] = [];
  if (value.text.trim() || value.url) {
    records.push({
      requestId: crypto.randomUUID(),
      file: value.url ? null : new File([value.text], "Clipboard.txt", { type: "text/plain" }),
      title: value.title.trim() || value.text.trim().split("\n")[0]?.slice(0, 120) || value.url,
      body: value.text.trim() || value.url,
      sourceUrl: value.url,
    });
  }
  for (const file of value.files) {
    const type = incomingFileType(file);
    const body = type === "application/pdf" ? file.name : await file.text();
    if (!body.trim() || body.length > 2_000_000) throw new Error("incoming_text_too_large");
    records.push({ requestId: crypto.randomUUID(), file, title: file.name, body, sourceUrl: "" });
  }
  return { ...identity, capturedAt: new Date().toISOString(), records };
}

export async function confirmInstallationImport(
  draft: InstallationImportDraft,
  input: { tenantId: string; userId: string; category: string; origin?: string },
  request: typeof apiRequest = apiRequest,
): Promise<{ itemIds: string[]; fileIds: string[] }> {
  if (draft.tenantId !== input.tenantId || draft.userId !== input.userId)
    throw new Error("incoming_identity_changed");
  if (draft.category !== undefined && draft.category !== input.category)
    throw new Error("incoming_destination_changed");
  draft.category = input.category;
  for (const record of draft.records) {
    if (record.itemId) continue;
    if (record.file && !record.fileId) {
      const bytes = new Uint8Array(await record.file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32_768)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
      const file = await request<{ id: string }>("/v1/files/inline", {
        method: "POST",
        body: JSON.stringify({
          filename: record.file.name,
          content_type: incomingFileType(record.file),
          content_base64: btoa(binary),
        }),
      });
      record.fileId = file.id;
    }
    const filePath = record.fileId
      ? `/v1/files/${encodeURIComponent(record.fileId)}/content?tenant_context=${encodeURIComponent(input.tenantId)}`
      : "";
    const sourceUrl = incomingSourceUrl(
      record.sourceUrl,
      filePath ? new URL(filePath, input.origin ?? location.origin).href : "",
    );
    const item = await request<{ id: string }>("/v1/intake/items", {
      method: "POST",
      body: JSON.stringify({
        client_request_id: record.requestId,
        category: input.category,
        title: record.title,
        source_url: sourceUrl,
        captured_at: draft.capturedAt,
        body: record.body,
        original_snapshot: {
          title: record.title,
          source_url: sourceUrl,
          captured_at: draft.capturedAt,
          body: record.body,
          origin: "capture",
        },
      }),
    });
    record.itemId = item.id;
  }
  return {
    itemIds: draft.records.flatMap((record) => (record.itemId ? [record.itemId] : [])),
    fileIds: draft.records.flatMap((record) => (record.fileId ? [record.fileId] : [])),
  };
}
