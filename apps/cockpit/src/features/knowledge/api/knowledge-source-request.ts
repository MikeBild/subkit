import type { ApiRequestBody } from "@/api/call";
import type { AddMode, Rhythm } from "@/features/knowledge/model/add-source-model";
import {
  type RefreshRhythm,
  refreshFields,
} from "@/features/knowledge/model/knowledge-sources-model";

export function urlSourceBody(
  url: string,
  rhythm: Exclude<RefreshRhythm, "custom">,
): ApiRequestBody<"/v1/knowledge-sources/url", "post"> {
  const refresh = refreshFields(rhythm);
  return {
    url: url.trim(),
    refresh_strategy: refresh.refresh_strategy,
    ...(refresh.refresh_cron ? { refresh_cron: refresh.refresh_cron } : {}),
  };
}

export type CreateSourceRequest =
  | { kind: "url"; body: ApiRequestBody<"/v1/knowledge-sources/url", "post"> }
  | { kind: "text"; body: ApiRequestBody<"/v1/knowledge-sources/inline", "post"> }
  | { kind: "file"; file: File };

export function createSourceRequest(input: {
  mode: AddMode;
  url: string;
  rhythm: Rhythm;
  name: string;
  text: string;
  file: File | null;
}): CreateSourceRequest {
  if (input.mode === "url") return { kind: "url", body: urlSourceBody(input.url, input.rhythm) };
  if (input.mode === "text")
    return {
      kind: "text",
      body: { name: input.name.trim(), content: input.text, mime_type: "text/markdown" },
    };
  return { kind: "file", file: input.file as File };
}

export function addressPatchBody(
  current: { url: string; rhythm: RefreshRhythm },
  next: { url: string; rhythm: Rhythm | null },
): ApiRequestBody<"/v1/knowledge-sources/{id}", "patch"> {
  const url = next.url.trim();
  return {
    ...(next.rhythm !== null && next.rhythm !== current.rhythm ? refreshFields(next.rhythm) : {}),
    ...(url !== current.url ? { source_uri: url } : {}),
  };
}

export function contentSaveBody(input: {
  version: string;
  path: string;
  content: string;
  note: string;
}): ApiRequestBody<"/v1/knowledge-sources/{id}/content", "put"> {
  const note = input.note.trim();
  return {
    expected_version: input.version,
    path: input.path,
    content: input.content,
    ...(note ? { note } : {}),
  };
}
