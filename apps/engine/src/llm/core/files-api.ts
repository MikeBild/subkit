// LLM-provider Files API: upload large attachments out-of-band so they
// don't burn context-window tokens for every turn. Different providers
// expose different endpoints; this module unifies them behind one shape.
//
// Subkit's filestore role is filled by
// `apps/engine/src/storage/object-store.ts` for tenant blobs; this
// module covers the LLM-provider side: upload to the provider's
// Files API and return a `file_id` the conversation context
// assembler can paste into a prompt as a `<file>` reference rather
// than as inline base64.
//
// Use only when a model is `filesApiSupport: true` (see
// `capabilities.ts`); other models inline the bytes via the chat
// message content array, which the AI SDK normalises.

import { getConfig } from "../../config/loader.ts";
import { logger } from "../../logging/logger.ts";
import type { ProviderKind } from "./model-init.ts";

async function readProviderKey(
  provider: "anthropic" | "openai" | "gemini",
  envFallback: string,
): Promise<string | undefined> {
  try {
    const v = getConfig().llm.providers[provider].api_key;
    if (v && v.length > 0) return v;
  } catch {
    /* loader not initialised */
  }
  const env = process.env[envFallback];
  return env && env.length > 0 ? env : undefined;
}

export interface UploadedFile {
  file_id: string;
  provider: ProviderKind;
  expires_at?: Date;
  bytes: number;
  filename: string;
  mime_type: string;
}

export interface UploadFileParams {
  provider: ProviderKind;
  data: Uint8Array;
  mimeType: string;
  filename: string;
  /** Optional override for the API base URL — tests point this at a mock. */
  baseUrl?: string;
  /** Optional fetch override — tests inject a stub. */
  fetchImpl?: typeof fetch;
}

export class FilesApiError extends Error {
  readonly status: number | undefined;
  readonly provider: ProviderKind;
  constructor(provider: ProviderKind, message: string, status?: number) {
    super(message);
    this.name = "FilesApiError";
    this.provider = provider;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Upload a file to the configured provider's Files API. Returns a
 * provider-side handle the chat-completion API can reference. Throws
 * `FilesApiError` on HTTP non-2xx or malformed JSON.
 *
 * Provider matrix:
 *   - anthropic  → POST /v1/files  (multipart/form-data, x-api-key auth)
 *   - openai     → POST /v1/files  (multipart, Bearer auth, purpose=user_data)
 *   - gemini     → POST /upload/v1beta/files (resumable two-phase upload)
 *   - others     → throw — caller should inline-encode the bytes
 */
export async function uploadFileViaApi(p: UploadFileParams): Promise<UploadedFile> {
  switch (p.provider) {
    case "anthropic":
      return uploadAnthropic(p);
    case "openai":
      return uploadOpenAI(p);
    case "gemini":
      return uploadGemini(p);
    default:
      throw new FilesApiError(
        p.provider,
        `Files API upload not supported for provider '${p.provider}' — inline-encode the attachment instead.`,
      );
  }
}

async function uploadAnthropic(p: UploadFileParams): Promise<UploadedFile> {
  const apiKey = await readProviderKey("anthropic", "ANTHROPIC_API_KEY");
  if (!apiKey) throw new FilesApiError("anthropic", "llm.providers.anthropic.api_key not set");
  const baseUrl = p.baseUrl ?? "https://api.anthropic.com";
  const fetchFn = p.fetchImpl ?? fetch;

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(p.data)], { type: p.mimeType }), p.filename);

  const res = await fetchFn(`${baseUrl}/v1/files`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await safeText(res);
    throw new FilesApiError(
      "anthropic",
      `Anthropic Files API upload failed: ${res.status} ${errText}`,
      res.status,
    );
  }

  // Anthropic returns: { id, type, filename, mime_type, size_bytes, created_at, downloadable }
  const body = (await res.json()) as {
    id?: string;
    filename?: string;
    mime_type?: string;
    size_bytes?: number;
  };
  if (!body.id) {
    throw new FilesApiError("anthropic", "Anthropic Files API returned no `id` field");
  }
  logger.info({
    module: "llm.files_api",
    action: "files.uploaded",
    provider: "anthropic",
    file_id: body.id,
    bytes: body.size_bytes ?? p.data.byteLength,
  });
  return {
    file_id: body.id,
    provider: "anthropic",
    bytes: body.size_bytes ?? p.data.byteLength,
    filename: body.filename ?? p.filename,
    mime_type: body.mime_type ?? p.mimeType,
  };
}

async function uploadOpenAI(p: UploadFileParams): Promise<UploadedFile> {
  const apiKey = await readProviderKey("openai", "OPENAI_API_KEY");
  if (!apiKey) throw new FilesApiError("openai", "llm.providers.openai.api_key not set");
  const baseUrl = p.baseUrl ?? "https://api.openai.com";
  const fetchFn = p.fetchImpl ?? fetch;

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(p.data)], { type: p.mimeType }), p.filename);
  // OpenAI requires `purpose`; "user_data" is the catch-all that also
  // works with the assistants API and chat-completion attachments.
  form.append("purpose", "user_data");

  const res = await fetchFn(`${baseUrl}/v1/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await safeText(res);
    throw new FilesApiError(
      "openai",
      `OpenAI Files API upload failed: ${res.status} ${errText}`,
      res.status,
    );
  }

  const body = (await res.json()) as {
    id?: string;
    filename?: string;
    bytes?: number;
    expires_at?: number;
  };
  if (!body.id) {
    throw new FilesApiError("openai", "OpenAI Files API returned no `id` field");
  }
  logger.info({
    module: "llm.files_api",
    action: "files.uploaded",
    provider: "openai",
    file_id: body.id,
    bytes: body.bytes ?? p.data.byteLength,
  });
  return {
    file_id: body.id,
    provider: "openai",
    bytes: body.bytes ?? p.data.byteLength,
    filename: body.filename ?? p.filename,
    mime_type: p.mimeType,
    ...(body.expires_at ? { expires_at: new Date(body.expires_at * 1000) } : {}),
  };
}

async function uploadGemini(p: UploadFileParams): Promise<UploadedFile> {
  const apiKey = await readProviderKey("gemini", "GEMINI_API_KEY");
  if (!apiKey) throw new FilesApiError("gemini", "llm.providers.gemini.api_key not set");
  const baseUrl = p.baseUrl ?? "https://generativelanguage.googleapis.com";
  const fetchFn = p.fetchImpl ?? fetch;

  // Gemini uses a two-phase resumable upload. Phase 1: POST metadata,
  // get an upload URL back via the `x-goog-upload-url` header.
  const initRes = await fetchFn(`${baseUrl}/upload/v1beta/files?key=${apiKey}`, {
    method: "POST",
    headers: {
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(p.data.byteLength),
      "x-goog-upload-header-content-type": p.mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: p.filename } }),
  });
  if (!initRes.ok) {
    throw new FilesApiError(
      "gemini",
      `Gemini Files API init failed: ${initRes.status} ${await safeText(initRes)}`,
      initRes.status,
    );
  }
  const uploadUrl = initRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new FilesApiError("gemini", "Gemini Files API returned no upload URL");
  }

  // Phase 2: PUT the bytes to the upload URL with finalize command.
  const uploadRes = await fetchFn(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(p.data.byteLength),
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload, finalize",
    },
    body: new Blob([new Uint8Array(p.data)]),
  });
  if (!uploadRes.ok) {
    throw new FilesApiError(
      "gemini",
      `Gemini Files API upload failed: ${uploadRes.status} ${await safeText(uploadRes)}`,
      uploadRes.status,
    );
  }
  const body = (await uploadRes.json()) as {
    file?: { name?: string; size_bytes?: string; expiration_time?: string };
  };
  const fileName = body.file?.name;
  if (!fileName) {
    throw new FilesApiError("gemini", "Gemini Files API returned no `name`");
  }
  logger.info({
    module: "llm.files_api",
    action: "files.uploaded",
    provider: "gemini",
    file_id: fileName,
    bytes: Number(body.file?.size_bytes ?? p.data.byteLength),
  });
  return {
    file_id: fileName,
    provider: "gemini",
    bytes: Number(body.file?.size_bytes ?? p.data.byteLength),
    filename: p.filename,
    mime_type: p.mimeType,
    ...(body.file?.expiration_time ? { expires_at: new Date(body.file.expiration_time) } : {}),
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
