import type { IntakeCollectedSnapshot } from "../db/index.ts";
import { redactSecretShapes } from "../logging/index.ts";
import type { CreateIntakeItemParams } from "./intake-types.ts";

export function redactCollected(p: CreateIntakeItemParams): {
  params: CreateIntakeItemParams;
  redactions: number;
} {
  let redactions = 0;
  const clean = (value: string): string => {
    const r = redactSecretShapes(value);
    redactions += r.count;
    return r.text;
  };
  const cleanOptional = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : clean(value);
  const source = p.original_snapshot;
  const params: CreateIntakeItemParams = {
    ...p,
    title: clean(p.title),
    body: clean(p.body),
    source_author: cleanOptional(p.source_author),
    note: cleanOptional(p.note),
    original_snapshot: source && {
      ...source,
      title: cleanOptional(source.title),
      body: cleanOptional(source.body),
      source_author: cleanOptional(source.source_author),
    },
  };
  return { params, redactions };
}

export function snapshot(p: CreateIntakeItemParams, redactions = 0): IntakeCollectedSnapshot {
  const source = p.original_snapshot;
  const sourceUrl = source?.source_url ?? p.source_url;
  const described = {
    ...((source?.source_author ?? p.source_author)
      ? { source_author: source?.source_author ?? p.source_author }
      : {}),
    ...((source?.published_at ?? p.published_at)
      ? { published_at: source?.published_at ?? p.published_at }
      : {}),
    captured_at: source?.captured_at ?? p.captured_at,
    body: source?.body ?? p.body,
  };
  const title = source?.title ?? p.title;
  const redacted = redactions > 0 ? { redactions } : {};
  return sourceUrl === undefined
    ? {
        title,
        ...described,
        origin: "note",
        ...redacted,
        ...(p.attachment ? { attachment: p.attachment } : {}),
      }
    : {
        title,
        source_url: sourceUrl,
        ...described,
        origin: source?.origin ?? "capture",
        ...redacted,
      };
}
