import type { ProviderKind } from "./model-init.ts";

export interface UploadedFile {
  file_id: string;
  provider: ProviderKind;
  expires_at?: Date;
}

// Note: filesApiSupport must be true for the provider (check ModelCapabilities).
export async function uploadFileViaApi(
  _provider: ProviderKind,
  _data: Uint8Array,
  _mimeType: string,
  _filename: string,
): Promise<UploadedFile> {
  // Stub: real implementations call:
  //   Anthropic: POST /v1/files
  //   OpenAI: POST /v1/files
  //   Gemini: POST /upload/v1beta/files
  throw new Error("Files API upload not yet implemented for this provider");
}
