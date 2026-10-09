import type { ClipMetadata, Draft, Settings, WriteAttempt } from "./types.ts";

const settingsKey = "settings";
const draftKey = "draft";

export function normalizeEngineUrl(input: string): string {
  const url = new URL(input.trim());
  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Use an HTTPS address or HTTP on localhost.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The engine address cannot contain credentials, a query, or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function apiUrl(engineUrl: string, path: string): string {
  return `${engineUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export function normalizeSourceUrl(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  url.hash = "";
  return url.toString();
}

export async function urlHash(sourceUrl: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeSourceUrl(sourceUrl));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

export async function clipPath(sourceUrl: string, suffix?: string): Promise<string> {
  const hash = await urlHash(sourceUrl);
  return `/clips/${hash}${suffix ? `-${suffix}` : ""}.md`;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

export function markdown(metadata: ClipMetadata, body: string): string {
  const fields = [
    `title: ${quoted(metadata.title)}`,
    `source_url: ${quoted(normalizeSourceUrl(metadata.sourceUrl))}`,
    `captured_at: ${quoted(metadata.capturedAt)}`,
  ];
  if (metadata.author) fields.push(`author: ${quoted(metadata.author)}`);
  if (metadata.publishedAt) fields.push(`published_at: ${quoted(metadata.publishedAt)}`);
  return `---\n${fields.join("\n")}\n---\n\n${body.trim()}\n`;
}

export function createDraft(
  metadata: ClipMetadata,
  body: string,
  engineUrl: string,
  captureTabId?: number,
): Draft {
  return {
    id: crypto.randomUUID(),
    engineUrl,
    ...(captureTabId === undefined ? {} : { captureTabId }),
    metadata,
    body,
    state: "ready",
  };
}

export function isDraftForEngine(draft: Draft, engineUrl: string): boolean {
  return draft.engineUrl === engineUrl;
}

export function attemptMatchesDocument(
  attempt: WriteAttempt,
  documents: { path: string; content: string }[],
): boolean {
  return documents.some(
    (document) => document.path === attempt.path && document.content === attempt.content,
  );
}

export function persistedCollectionSlug(
  existing: string | undefined,
  attempted: string | undefined,
  generated: string,
): string {
  return attempted || existing || generated;
}

export function parseInstallConfig(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const engineUrl = (value as { engine_url?: unknown }).engine_url;
  if (typeof engineUrl !== "string") return undefined;
  try {
    return normalizeEngineUrl(engineUrl);
  } catch {
    return undefined;
  }
}

export async function loadSettings(storage: {
  get(keys?: string | string[]): Promise<Record<string, unknown>>;
}): Promise<Settings> {
  const stored = await storage.get(settingsKey);
  const settings = stored[settingsKey];
  return settings && typeof settings === "object" ? (settings as Settings) : {};
}

export async function saveSettings(
  storage: { set(values: Record<string, unknown>): Promise<void> },
  settings: Settings,
): Promise<void> {
  await storage.set({ [settingsKey]: settings });
}

export async function loadDraft(storage: {
  get(keys?: string | string[]): Promise<Record<string, unknown>>;
}): Promise<Draft | undefined> {
  const stored = await storage.get(draftKey);
  const draft = stored[draftKey];
  return draft && typeof draft === "object" ? (draft as Draft) : undefined;
}

export async function saveDraft(
  storage: { set(values: Record<string, unknown>): Promise<void> },
  draft: Draft,
): Promise<void> {
  await storage.set({ [draftKey]: draft });
}

export async function clearDraft(storage: { remove(keys: string): Promise<void> }): Promise<void> {
  await storage.remove(draftKey);
}
