import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { uploadPath } from "../commands/files.ts";
import type { EngineClient } from "../engine-client.ts";
import { detectMime } from "../utils/mime.ts";
import { sanitizePathInput } from "./path-input.ts";

const MAX_INLINE_LOCAL_PATH_BYTES = 262144;

interface PathCandidate {
  raw: string;
  cleaned: string;
  start: number;
  end: number;
}

interface UploadedPath {
  raw: string;
  fid: string;
  filename: string;
  bytes: number;
}

interface InlinedPath {
  raw: string;
  path: string;
  filename: string;
  bytes: number;
  truncated: boolean;
}

interface SkippedPath {
  raw: string;
  reason: "not_found" | "not_file" | "upload_failed" | "read_failed";
  detail?: string;
}

interface AutoUploadResult {
  rewritten: string;
  inlined: InlinedPath[];
  uploaded: UploadedPath[];
  skipped: SkippedPath[];
}

type LocalPathMode = "workflow_input" | "knowledge_source";

interface AutoUploadOptions {
  mode?: LocalPathMode;
}

const PATH_RE =
  /(["'])(?:file:\/\/|~\/|\.{1,2}\/|\/)(?:\\.|(?!\1)[^\r\n])*?\1|(?:^|(?<=\s))(?:file:\/\/|~\/|\.{1,2}\/|\/)(?:\\.|[^\s"'<>`(){}[\]])+/g;

const TRAILING_PUNCT_RE = /[.,;:!?)\]>]+$/;

const KNOWLEDGE_SOURCE_INTENT_RE =
  /\b(?:knowledge\s*sources?|knowledge[-_\s]?source|wissensquelle|wissensquellen|knowledge\s*base|kb|ingest(?:e|ion)?|index(?:iere|ieren|ing)?|als\s+(?:wissen|knowledge)|suchbar(?:e|en)?|einlesen\s+als\s+wissen)\b/i;

export function extractCandidatePaths(input: string): PathCandidate[] {
  const out: PathCandidate[] = [];
  for (const m of input.matchAll(PATH_RE)) {
    if (m.index === undefined) continue;
    const raw = m[0];
    let cleaned = normalizeCandidatePath(raw);
    const trail = cleaned.match(TRAILING_PUNCT_RE);
    if (trail && trail.index !== undefined && trail.index > 0) {
      const beforePunct = cleaned[trail.index - 1] ?? "";
      if (/[A-Za-z0-9]/.test(beforePunct)) {
        cleaned = cleaned.slice(0, trail.index);
      }
    }
    out.push({
      raw,
      cleaned,
      start: m.index,
      end: m.index + raw.length,
    });
  }
  return out;
}

function normalizeCandidatePath(raw: string): string {
  let cleaned = sanitizePathInput(raw);
  const quoted =
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"));
  if (quoted) cleaned = sanitizePathInput(cleaned.slice(1, -1));
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      return cleaned;
    }
  }
  return cleaned.replace(/\\([ "'()&;<>[\]{}$`!#])/g, "$1");
}

function resolveCandidate(cwd: string, cleaned: string): string {
  if (cleaned.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return resolve(home, cleaned.slice(2));
  }
  return resolve(cwd, cleaned);
}

function shouldInlinePath(abs: string): boolean {
  const mime = detectMime(abs);
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/x-javascript"
  );
}

export function inferLocalPathMode(input: string): LocalPathMode {
  return KNOWLEDGE_SOURCE_INTENT_RE.test(input) ? "knowledge_source" : "workflow_input";
}

function inlineBlock(item: InlinedPath, body: string): string {
  const lang = detectMime(item.path).includes("markdown")
    ? "markdown"
    : detectMime(item.path).includes("json")
      ? "json"
      : detectMime(item.path).includes("html")
        ? "html"
        : "";
  const truncated = item.truncated
    ? `\n\n[subkit: file truncated at ${MAX_INLINE_LOCAL_PATH_BYTES} bytes]`
    : "";
  return [
    `## Local file contents: ${item.filename}`,
    `Path: ${item.path}`,
    "Use this content when the user refers to this local file path.",
    "",
    `\`\`\`${lang}`,
    `${body}${truncated}`,
    "```",
  ].join("\n");
}

export async function autoUploadLocalPaths(
  input: string,
  client: EngineClient,
  cwd: string,
  conversationId: string | null | undefined,
  opts: AutoUploadOptions = {},
): Promise<AutoUploadResult> {
  const candidates = extractCandidatePaths(input);
  if (candidates.length === 0) {
    return { rewritten: input, inlined: [], uploaded: [], skipped: [] };
  }
  const mode = opts.mode ?? inferLocalPathMode(input);

  const inlined: InlinedPath[] = [];
  const uploaded: UploadedPath[] = [];
  const skipped: SkippedPath[] = [];
  const inlineBlocks: string[] = [];
  const replacements: Array<{ start: number; end: number; with: string }> = [];

  for (const c of candidates) {
    const abs = resolveCandidate(cwd, c.cleaned);
    if (!existsSync(abs)) {
      skipped.push({ raw: c.raw, reason: "not_found" });
      continue;
    }
    const st = statSync(abs);
    if (!st.isFile()) {
      skipped.push({ raw: c.raw, reason: "not_file" });
      continue;
    }
    if (shouldInlinePath(abs) && mode === "workflow_input") {
      try {
        const bytes = st.size;
        let body = readFileSync(abs, "utf8");
        const truncated = Buffer.byteLength(body, "utf8") > MAX_INLINE_LOCAL_PATH_BYTES;
        if (truncated) {
          body = Buffer.from(body, "utf8")
            .subarray(0, MAX_INLINE_LOCAL_PATH_BYTES)
            .toString("utf8");
        }
        const item = {
          raw: c.raw,
          path: abs,
          filename: basename(abs),
          bytes,
          truncated,
        };
        inlined.push(item);
        inlineBlocks.push(inlineBlock(item, body));
      } catch (err) {
        skipped.push({
          raw: c.raw,
          reason: "read_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    try {
      const row = await uploadPath(client, abs, { quiet: true });
      uploaded.push({
        raw: c.raw,
        fid: row.id,
        filename: row.filename,
        bytes: st.size,
      });
      if (conversationId) {
        try {
          await client.linkFile(row.id, {
            resource_type: "conversation",
            resource_id: conversationId,
            role: "attachment",
          });
        } catch {}
      }
      replacements.push({
        start: c.start,
        end: c.end,
        with: `@file:${row.id}`,
      });
    } catch (err) {
      skipped.push({
        raw: c.raw,
        reason: "upload_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (replacements.length === 0) {
    const rewritten =
      inlineBlocks.length > 0 ? `${input}\n\n---\n${inlineBlocks.join("\n\n")}` : input;
    return { rewritten, inlined, uploaded, skipped };
  }

  let rewritten = input;
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    rewritten = rewritten.slice(0, r.start) + r.with + rewritten.slice(r.end);
  }
  if (inlineBlocks.length > 0) {
    rewritten = `${rewritten}\n\n---\n${inlineBlocks.join("\n\n")}`;
  }
  return { rewritten, inlined, uploaded, skipped };
}
