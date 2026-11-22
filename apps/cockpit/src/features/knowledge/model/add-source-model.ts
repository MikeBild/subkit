import { extOf, parseCsv } from "@shared/file-kinds.ts";
import { MAX_FILE, SOURCE_EXT } from "./knowledge";

export type AddMode = "url" | "file" | "text";
export const ADD_MODES: readonly AddMode[] = ["url", "file", "text"];

export type Rhythm = "never" | "daily" | "weekly";
export const RHYTHMS: readonly Rhythm[] = ["never", "daily", "weekly"];

const URL_OK = /^https?:\/\/\S+\.\S+/;
const TEXT_PREVIEW = ["md", "txt", "csv", "json", "html"];

export function isSourceUrl(url: string): boolean {
  return URL_OK.test(url.trim());
}

export function addModeOf(value: string): AddMode | undefined {
  return ADD_MODES.find((x) => x === value);
}

export interface AddSourceDraft {
  mode: AddMode;
  url: string;
  hasFile: boolean;
  name: string;
  text: string;
}

export function addSourceReady(draft: AddSourceDraft): boolean {
  if (draft.mode === "url") return isSourceUrl(draft.url);
  if (draft.mode === "file") return draft.hasFile;
  return Boolean(draft.name.trim() && draft.text.trim());
}

export type SourceFileProblem = "unsupported" | "tooBig" | null;

export function sourceFileProblem(name: string, size: number): SourceFileProblem {
  if (!SOURCE_EXT.includes(extOf(name))) return "unsupported";
  if (size > MAX_FILE) return "tooBig";
  return null;
}

export function previewsAsText(name: string): boolean {
  return TEXT_PREVIEW.includes(extOf(name));
}

export const SOURCE_ACCEPT = SOURCE_EXT.map((x) => `.${x}`);

export type FilePreview =
  | { kind: "none" }
  | { kind: "markdown"; text: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "code"; code: string; lang: "xml" | "json" | "text" };

export function filePreview(name: string, text: string | null): FilePreview {
  const e = extOf(name);
  if (text === null) return { kind: "none" };
  if (e === "md") return { kind: "markdown", text: text.slice(0, 4000) };
  if (e === "csv") return { kind: "table", rows: parseCsv(text, 6) };
  return {
    kind: "code",
    code: text.split("\n").slice(0, 12).join("\n"),
    lang: e === "html" ? "xml" : e === "json" ? "json" : "text",
  };
}
