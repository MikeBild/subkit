export type ErrorCause =
  | "auth_failed"
  | "timeout"
  | "schema_mismatch"
  | "connector_missing"
  | "connector_unavailable"
  | "budget_exhausted"
  | "approval_mismatch"
  | "upstream_error"
  | "rate_limited"
  | "version_unsupported"
  | "unclassified";
export type ErrorCase =
  | "unreachable"
  | "tooOld"
  | "signinCancelled"
  | "session"
  | "keyRejected"
  | "tooBig"
  | "duplicate"
  | "feedbackFailed"
  | "offline"
  | "runFailed"
  | "taskFailed"
  | "reauth"
  | "skillConflict"
  | "pageFailed"
  | "autoPaused"
  | "runApproval";

export const ERROR_META: Record<
  ErrorCase,
  { cause: ErrorCause; code: string; http: number | null }
> = {
  unreachable: { cause: "timeout", code: "timeout", http: null },
  tooOld: { cause: "version_unsupported", code: "version_unsupported", http: 426 },
  signinCancelled: { cause: "auth_failed", code: "auth_cancelled", http: null },
  session: { cause: "auth_failed", code: "auth_expired", http: 401 },
  keyRejected: { cause: "auth_failed", code: "auth_failed", http: 401 },
  tooBig: { cause: "unclassified", code: "payload_too_large", http: 413 },
  duplicate: { cause: "unclassified", code: "duplicate_content", http: 409 },
  feedbackFailed: { cause: "timeout", code: "timeout", http: 504 },
  offline: { cause: "timeout", code: "server_offline", http: 503 },
  runFailed: { cause: "auth_failed", code: "auth_failed", http: 401 },
  taskFailed: { cause: "timeout", code: "timeout", http: 504 },
  reauth: { cause: "auth_failed", code: "auth_failed", http: 401 },
  skillConflict: { cause: "approval_mismatch", code: "version_conflict", http: 409 },
  pageFailed: { cause: "unclassified", code: "load_failed", http: 500 },
  autoPaused: { cause: "approval_mismatch", code: "approval_mismatch", http: 403 },
  runApproval: { cause: "approval_mismatch", code: "approval_mismatch", http: 403 },
};

export type ErrorKind = ErrorCase | (string & {});

export interface ErrorMeta {
  cause: ErrorCause;
  code: string;
  http: number | null;
}

export function isErrorCase(kind: string): kind is ErrorCase {
  return Object.hasOwn(ERROR_META, kind);
}

export function errorMeta(kind: ErrorKind): ErrorMeta {
  return isErrorCase(kind) ? ERROR_META[kind] : { cause: "unclassified", code: kind, http: null };
}

export interface TechRowLabels {
  cause: string;
  code: string;
  http: string;
  request: string;
  time: string;
  server: string;
  causes: Record<ErrorCause, string>;
}

export function techRows(input: {
  kind: ErrorKind;
  at: number;
  labels: TechRowLabels;
  fmt: (iso: string) => string;
  server?: string | undefined;
}): [string, string][] {
  const { kind, at, labels, fmt, server } = input;
  const meta = errorMeta(kind);
  return [
    [labels.cause, labels.causes[meta.cause]],
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

export const SLOW_DELAY_MS = 1500;
export const SKELETON_DELAY_MS = 150;
export const SKELETON_MIN_MS = 300;

export function loadingPhase(elapsed: number, duration: number): "blank" | "skeleton" | "ready" {
  if (duration <= SKELETON_DELAY_MS) return elapsed >= duration ? "ready" : "blank";
  if (elapsed < SKELETON_DELAY_MS) return "blank";
  return elapsed >= Math.max(duration, SKELETON_DELAY_MS + SKELETON_MIN_MS) ? "ready" : "skeleton";
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
