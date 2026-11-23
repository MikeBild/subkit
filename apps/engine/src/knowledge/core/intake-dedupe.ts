export const INTAKE_SIMILARITY_THRESHOLD = 0.9;
export const INTAKE_SIMILARITY_CANDIDATES = 50;
const SIMILARITY_TEXT_CHARS = 2000;
const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i;

export type IntakeDuplicateMatch = "source_url" | "similar";

export interface IntakeLearningTarget {
  readonly scope: string;
  readonly workflow_id: string | null;
  readonly connector_id: string | null;
}

interface LearningTargetFields {
  readonly scope?: string | null | undefined;
  readonly workflow_id?: string | null | undefined;
  readonly connector_id?: string | null | undefined;
}

export function intakeLearningTarget(
  fields: LearningTargetFields | null | undefined,
): IntakeLearningTarget | null {
  if (!fields?.scope) return null;
  return {
    scope: fields.scope,
    workflow_id: fields.workflow_id || null,
    connector_id: fields.connector_id || null,
  };
}

export function sameLearningTarget(
  a: LearningTargetFields | null | undefined,
  b: LearningTargetFields | null | undefined,
): boolean {
  const left = intakeLearningTarget(a);
  const right = intakeLearningTarget(b);
  if (!left || !right) return left === right;
  return (
    left.scope === right.scope &&
    left.workflow_id === right.workflow_id &&
    left.connector_id === right.connector_id
  );
}

export function absorbedRequestKey(client_request_id: string, digest: string): string {
  return `${client_request_id}:${digest}`;
}

export function absorbedRequestPrefix(client_request_id: string): string {
  return `${client_request_id}:`;
}

export type AbsorbedReplay =
  | { readonly kind: "none" }
  | { readonly kind: "replayed"; readonly item_id: string }
  | { readonly kind: "conflict" };

export function absorbedReplay(
  client_request_id: string,
  digest: string,
  evidence: ReadonlyArray<{ readonly item_id: string; readonly session_id: string }>,
): AbsorbedReplay {
  const prefix = absorbedRequestPrefix(client_request_id);
  const own = evidence.filter((e) => e.session_id.startsWith(prefix));
  if (own.length === 0) return { kind: "none" };
  const key = absorbedRequestKey(client_request_id, digest);
  const same = own.find((e) => e.session_id === key);
  return same ? { kind: "replayed", item_id: same.item_id } : { kind: "conflict" };
}

export function normalizeSourceUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a, av], [b, bv]) => (a === b ? compare(av, bv) : compare(a, b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${host}${url.port ? `:${url.port}` : ""}${path}${query}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sourceUrlHost(raw: string | null | undefined): string | null {
  const normalized = normalizeSourceUrl(raw);
  if (!normalized) return null;
  const end = normalized.search(/[:/?]/);
  return end === -1 ? normalized : normalized.slice(0, end);
}

export function sameSourceUrl<T extends { id: string; source_url: string | null }>(
  sourceUrl: string | null | undefined,
  candidates: readonly T[],
): T | null {
  const wanted = normalizeSourceUrl(sourceUrl);
  if (!wanted) return null;
  return candidates.find((c) => normalizeSourceUrl(c.source_url) === wanted) ?? null;
}

export function similarityText(title: string, body: string): string {
  return `${title.trim()}\n\n${body.trim()}`.slice(0, SIMILARITY_TEXT_CHARS);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function mostSimilar(
  vector: readonly number[],
  candidates: ReadonlyArray<{ id: string; vector: readonly number[] | null | undefined }>,
  threshold = INTAKE_SIMILARITY_THRESHOLD,
): { id: string; cosine: number } | null {
  let best: { id: string; cosine: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.vector?.length) continue;
    const score = cosine(vector, candidate.vector);
    if (score >= threshold && (best === null || score > best.cosine))
      best = { id: candidate.id, cosine: score };
  }
  return best;
}

export function intakeGroupKey(p: {
  source_url?: string | null | undefined;
  repo?: string | null | undefined;
  tags?: readonly string[] | undefined;
}): string | null {
  const host = sourceUrlHost(p.source_url);
  if (host) return `site:${host}`;
  const repo = p.repo?.trim().toLowerCase();
  if (repo) return `repo:${repo}`;
  const tag = [...(p.tags ?? [])]
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .sort()[0];
  return tag ? `tag:${tag}` : null;
}
