import type { RawChunk } from "../../docs-ingestion/types.ts";
import { canonicalBundleSerialization, parseBundle } from "../bundle.ts";

export type KnowledgeVersionContent =
  | { kind: "document"; filename: string; mime: string | null; text: string }
  | { kind: "bundle"; filename: string; files: { path: string; content: string }[] };

const RESTORED_NOTE_PREFIX = "restored from v";

export function restoredNote(version: number): string {
  return `${RESTORED_NOTE_PREFIX}${version}`;
}

export { knowledgeContentHash } from "./content.ts";

export function knowledgeVersionContent(p: {
  source_type: string;
  upload: { filename: string; mime?: string | undefined };
  text: string;
  parsed_chunks?: RawChunk[] | undefined;
}): KnowledgeVersionContent {
  if (p.source_type === "bundle") {
    return {
      kind: "bundle",
      filename: p.upload.filename,
      files: (p.parsed_chunks ?? []).map((chunk) => ({
        path: chunk.path ?? p.upload.filename,
        content: chunk.content,
      })),
    };
  }
  return {
    kind: "document",
    filename: p.upload.filename,
    mime: p.upload.mime ?? null,
    text: p.text.replaceAll("\u0000", ""),
  };
}

interface KnowledgeVersionUpload {
  text: string;
  filename: string;
  mime: string | null;
  parsed_chunks: RawChunk[] | null;
}

export function knowledgeVersionUpload(content: KnowledgeVersionContent): KnowledgeVersionUpload {
  if (content.kind === "document") {
    return {
      text: content.text,
      filename: content.filename,
      mime: content.mime,
      parsed_chunks: null,
    };
  }
  return {
    text: canonicalBundleSerialization(content.files),
    filename: content.filename,
    mime: "application/json",
    parsed_chunks: parseBundle(content.files).chunks,
  };
}

export function knowledgeVersionDocuments(
  content: KnowledgeVersionContent,
): { path: string; content: string }[] {
  if (content.kind === "document") return [{ path: content.filename, content: content.text }];
  return content.files;
}
