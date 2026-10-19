import { type SQLWrapper, sql } from "drizzle-orm";
import { FILE_SENTINEL_RE } from "../files/sentinel.ts";

export const TITLE_SOURCE_CHARS = 300;
export const TITLE_FALLBACK_JSON_BYTES = 65_536;
const ECMASCRIPT_WHITESPACE =
  "\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const TRIM_WHITESPACE = `^[${ECMASCRIPT_WHITESPACE}]+|[${ECMASCRIPT_WHITESPACE}]+$`;
const COLLAPSE_WHITESPACE = `[${ECMASCRIPT_WHITESPACE}]+`;

function trimmed(value: SQLWrapper) {
  return sql<string>`regexp_replace(${value},${TRIM_WHITESPACE},'','g')`;
}

export function titleSourceText(content: SQLWrapper) {
  const text = sql`${content}->>'text'`;
  const summary = sql`${content}->>'summary'`;
  const raw = sql`CASE
    WHEN jsonb_typeof(${content})='string' THEN ${trimmed(sql`${content} #>> '{}'`)}
    WHEN jsonb_typeof(${content}->'text')='string' AND ${trimmed(text)}<>'' THEN ${trimmed(text)}
    WHEN jsonb_typeof(${content}->'summary')='string' AND ${trimmed(summary)}<>'' THEN ${trimmed(summary)}
    ELSE NULL END`;
  return sql<
    string | null
  >`nullif(regexp_replace(${raw},${FILE_SENTINEL_RE.source},'[file]','g'),'')`;
}

export function titleSourceSupported(content: SQLWrapper) {
  return sql<boolean>`(${titleSourceText(content)} IS NOT NULL OR coalesce(octet_length(${content}::text),0)<=${TITLE_FALLBACK_JSON_BYTES})`;
}

export function titleSourceProjection(content: SQLWrapper) {
  const text = titleSourceText(content);
  return sql<unknown>`CASE WHEN ${text} IS NOT NULL THEN jsonb_build_object('text',left(${text},${TITLE_SOURCE_CHARS}),'kind',CASE WHEN ${content}->>'kind'='confirmation_decision' THEN 'confirmation_decision' ELSE NULL END)
    WHEN octet_length(${content}::text)<=${TITLE_FALLBACK_JSON_BYTES} THEN ${content} ELSE NULL END`;
}

export function titleOpeningMatches(content: SQLWrapper, title: SQLWrapper) {
  const normalized = normalizedTitleSource(content);
  return sql<
    boolean | null
  >`CASE WHEN ${titleSourceText(content)} IS NOT NULL THEN coalesce(${title}=${normalized},false) ELSE NULL END`;
}

function normalizedTitleSource(content: SQLWrapper) {
  return sql<string>`btrim(regexp_replace(${titleSourceText(content)},${COLLAPSE_WHITESPACE},' ','g'))`;
}

export function titleOpeningPrefix(content: SQLWrapper, max: number) {
  return sql<string | null>`left(${normalizedTitleSource(content)},${max * 2})`;
}

export function titleFallbackProjection(title: SQLWrapper) {
  return sql<
    string | null
  >`CASE WHEN octet_length(${title})<=${TITLE_FALLBACK_JSON_BYTES} THEN ${title} ELSE NULL END`;
}

export function titleSourcePreview(content: SQLWrapper) {
  return sql<string | null>`left(${titleSourceText(content)},${TITLE_SOURCE_CHARS})`;
}

export function titleSourceConfirmation(content: SQLWrapper) {
  return sql<boolean>`coalesce(${content}->>'kind'='confirmation_decision',false)`;
}
