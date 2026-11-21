export type ErrorKind = string;

export interface ErrorMeta {
  cause: string;
  code: string;
  http: number | null;
}

export interface ErrorCopy {
  title: string;
  body: string;
}

export interface ErrorCatalog {
  cases: Readonly<Record<string, { meta: ErrorMeta; copy: ErrorCopy }>>;
  causes: Readonly<Record<string, string>>;
}

export const NO_ERROR_CATALOG: ErrorCatalog = { cases: {}, causes: {} };

export function errorMeta(catalog: ErrorCatalog, kind: ErrorKind): ErrorMeta {
  return catalog.cases[kind]?.meta ?? { cause: "unknown", code: kind, http: null };
}

export interface TechRowLabels {
  cause: string;
  code: string;
  http: string;
  request: string;
  time: string;
  server: string;
}

export function techRows(input: {
  kind: ErrorKind;
  at: number;
  catalog: ErrorCatalog;
  labels: TechRowLabels;
  fmt: (iso: string) => string;
  server?: string | undefined;
}): [string, string][] {
  const { kind, at, catalog, labels, fmt, server } = input;
  const meta = errorMeta(catalog, kind);
  return [
    [labels.cause, catalog.causes[meta.cause] ?? meta.cause],
    [labels.code, meta.code],
    [labels.http, meta.http ? String(meta.http) : "–"],
    [labels.request, requestId(kind, at)],
    [labels.time, fmt(new Date(at).toISOString())],
    [labels.server, server ?? "–"],
  ];
}

export function requestId(c: ErrorKind, at: number) {
  let h = 0;
  for (const ch of `${c}${Math.floor(at / 1000)}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `req_${h.toString(16).padStart(8, "0")}`;
}

export interface PageFailureSpec {
  onRetry: () => void;
  error?: unknown;
  testId: string;
  retryTestId?: string | undefined;
}

export function listPageFailure(input: {
  failed: boolean;
  loaded: boolean;
  onRetry: () => void;
  error?: unknown;
  collectionId: string;
}): PageFailureSpec | null {
  if (!input.failed || input.loaded) return null;
  return {
    onRetry: input.onRetry,
    error: input.error,
    testId: `${input.collectionId}-error`,
    retryTestId: `${input.collectionId}-retry`,
  };
}
