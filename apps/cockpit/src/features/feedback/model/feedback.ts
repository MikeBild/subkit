import type { components } from "@cli-core/engine-api/openapi";
import { redactDiagnosticText } from "@shared/redaction.ts";

export type FeedbackBody = components["schemas"]["SubmitFeedbackBody"];
export type FeedbackDiagnostics = components["schemas"]["FeedbackDiagnostics"];
export type FeedbackKind = FeedbackBody["kind"];
export type FeedbackClientKind = NonNullable<FeedbackDiagnostics["client_kind"]>;
export type FeedbackRecentError = NonNullable<FeedbackDiagnostics["recent_errors"]>[number];

export const FEEDBACK_KINDS = ["bug", "idea", "other"] as const satisfies readonly FeedbackKind[];
export const FEEDBACK_MAX_FILES = 3;
export const FEEDBACK_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const FEEDBACK_MAX_MESSAGE = 5000;
export const FEEDBACK_MAX_ERRORS = 10;
export const FEEDBACK_ACCEPT = ".png,.jpg,.jpeg,.pdf,.txt,.json";
export const FEEDBACK_DRAFT_KEY = "subkit.cockpit.feedback.draft";
export const FEEDBACK_SEARCH_PARAM = "feedback";

export interface FeedbackFile {
  id: string;
  name: string;
  size: number;
  content_base64: string;
}

export interface FeedbackDraft {
  kind: FeedbackKind;
  text: string;
  files: FeedbackFile[];
  screenshot: string | null;
  screenshotIncluded: boolean;
  diagnostics: boolean;
}

export function newFeedbackDraft(): FeedbackDraft {
  return {
    kind: "bug",
    text: "",
    files: [],
    screenshot: null,
    screenshotIncluded: false,
    diagnostics: true,
  };
}

export interface ScreenshotCapability {
  masksSecretFields: boolean;
  masksVisibleText: boolean;
}

export type ScreenshotHint = "masked" | "fields" | "none";

export function screenshotHint(capability: ScreenshotCapability | null): ScreenshotHint {
  if (capability?.masksVisibleText) return "masked";
  return capability?.masksSecretFields ? "fields" : "none";
}

export function hasFeedbackDraft(draft: FeedbackDraft): boolean {
  return (
    draft.text.trim() !== "" ||
    draft.files.length > 0 ||
    draft.kind !== "bug" ||
    !draft.diagnostics ||
    draft.screenshotIncluded
  );
}

export type AttachmentProblem = "limit" | "size" | "type";

export function attachmentProblem(
  count: number,
  file: { name: string; size: number },
): AttachmentProblem | null {
  if (count >= FEEDBACK_MAX_FILES) return "limit";
  if (file.size > FEEDBACK_MAX_FILE_BYTES) return "size";
  if (!/\.(png|jpe?g|pdf|txt|json)$/i.test(file.name)) return "type";
  return null;
}

export function base64OfDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma < 0 ? "" : dataUrl.slice(comma + 1);
}

interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isKind(value: unknown): value is FeedbackKind {
  return FEEDBACK_KINDS.some((kind) => kind === value);
}

export function readStoredDraft(storage: DraftStorage | null): FeedbackDraft {
  const draft = newFeedbackDraft();
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(FEEDBACK_DRAFT_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return draft;
    const stored = parsed as Record<string, unknown>;
    return {
      ...draft,
      kind: isKind(stored.kind) ? stored.kind : draft.kind,
      text: typeof stored.text === "string" ? stored.text.slice(0, FEEDBACK_MAX_MESSAGE) : "",
      diagnostics: stored.diagnostics !== false,
    };
  } catch {
    return draft;
  }
}

export function writeStoredDraft(storage: DraftStorage | null, draft: FeedbackDraft): void {
  try {
    if (!hasFeedbackDraft({ ...draft, screenshotIncluded: false })) {
      storage?.removeItem(FEEDBACK_DRAFT_KEY);
      return;
    }
    storage?.setItem(
      FEEDBACK_DRAFT_KEY,
      JSON.stringify({
        kind: draft.kind,
        text: draft.text,
        diagnostics: draft.diagnostics,
      }),
    );
  } catch {}
}

export function routeOf(pathname: string): string {
  const cut = pathname.search(/[?#]/);
  return cut < 0 ? pathname : pathname.slice(0, cut);
}

export function clientKindOf(input: { desktop: boolean; standalone: boolean }): FeedbackClientKind {
  if (input.desktop) return "desktop";
  return input.standalone ? "pwa" : "browser";
}

export interface DesktopFacts {
  appVersion: string | null;
  platform: string | null;
  errors: FeedbackRecentError[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function desktopFacts(bundle: unknown): DesktopFacts {
  const root = record(bundle);
  const os = record(root.os);
  const platform = [os.platform, os.release, os.arch].map(text).filter(Boolean).join(" ");
  const errors = Array.isArray(root.errors) ? root.errors : [];
  return {
    appVersion: text(record(root.app).version),
    platform: platform || null,
    errors: errors.flatMap((entry) => {
      const item = record(entry);
      const at = text(item.at);
      const code = [text(item.scope), text(item.message)].filter(Boolean).join(": ");
      return at && code && !Number.isNaN(Date.parse(at))
        ? [{ code, at: new Date(at).toISOString() }]
        : [];
    }),
  };
}

export function buildFeedbackDiagnostics(input: {
  clientKind: FeedbackClientKind;
  appVersion: string | null;
  platform: string | null;
  serverVersion: string | null;
  connection: string;
  route: string;
  errors: readonly FeedbackRecentError[];
  removed: string;
}): FeedbackDiagnostics {
  const clean = (value: string, max: number) =>
    redactDiagnosticText(value, { mask: input.removed }).trim().slice(0, max);
  const optional = (value: string | null) => {
    const cleaned = value ? clean(value, 200) : "";
    return cleaned ? cleaned : undefined;
  };
  const recent = [...input.errors]
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-FEEDBACK_MAX_ERRORS)
    .map((entry) => ({ code: clean(entry.code, 300), at: entry.at }))
    .filter((entry) => entry.code !== "");
  const route = clean(routeOf(input.route), 2000);
  return {
    client_kind: input.clientKind,
    app_version: optional(input.appVersion),
    platform: optional(input.platform),
    server_version: optional(input.serverVersion),
    connection: optional(input.connection),
    ...(route ? { route } : {}),
    ...(recent.length > 0 ? { recent_errors: recent } : {}),
  };
}

export function mergePrefill(current: string, prefill: string): string {
  if (!prefill.trim() || current.includes(prefill)) return current;
  return current.trim() ? `${current.trimEnd()}\n\n${prefill}` : prefill;
}

export function buildFeedbackBody(input: {
  requestId: string;
  draft: FeedbackDraft;
  diagnostics: FeedbackDiagnostics | null;
  createdAt?: string;
}): FeedbackBody {
  const { draft } = input;
  return {
    client_request_id: input.requestId,
    ...(input.createdAt ? { created_on_device_at: input.createdAt } : {}),
    kind: draft.kind,
    message: draft.text.trim().slice(0, FEEDBACK_MAX_MESSAGE),
    ...(draft.diagnostics && input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    ...(draft.files.length > 0
      ? {
          attachments: draft.files.map((file) => ({
            filename: file.name,
            content_base64: file.content_base64,
          })),
        }
      : {}),
    ...(draft.screenshotIncluded && draft.screenshot
      ? { screenshot_png_base64: draft.screenshot }
      : {}),
  };
}

export type FeedbackFailure = "generic" | "rateLimited" | "attachment";

export function feedbackFailure(error: unknown): FeedbackFailure {
  const status = record(error).status;
  if (status === 429) return "rateLimited";
  if (status === 413 || status === 422) return "attachment";
  return "generic";
}

export function clientErrorCode(error: unknown): string {
  const fields = record(error);
  if (typeof fields.status === "number")
    return `${text(fields.code) ?? "request_failed"} (${fields.status})`;
  return text(fields.name) ?? "Error";
}

export function appendClientError(
  log: readonly FeedbackRecentError[],
  entry: FeedbackRecentError,
): FeedbackRecentError[] {
  const last = log[log.length - 1];
  if (last && last.code === entry.code && Date.parse(entry.at) - Date.parse(last.at) < 1000)
    return [...log];
  return [...log, entry].slice(-FEEDBACK_MAX_ERRORS);
}

export function needsUncleanedWarning(files: readonly Pick<FeedbackFile, "name">[]): boolean {
  return files.some((file) => /\.(png|jpe?g|pdf)$/i.test(file.name));
}

export function feedbackResponse(
  error: unknown,
): { status: number; retry_after_seconds?: number } | null {
  const fields = record(error);
  if (typeof fields.status !== "number") return null;
  const seconds = record(fields.details).retry_after_seconds;
  return typeof seconds === "number"
    ? { status: fields.status, retry_after_seconds: seconds }
    : { status: fields.status };
}
