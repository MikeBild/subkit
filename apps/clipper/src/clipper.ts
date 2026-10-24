import type { CapturedClip, ClipMetadata, Draft, Settings, WriteAttempt } from "./types.ts";

const settingsKey = "settings";
const apiKeyKey = "apiKey";
const draftKey = "draft";
const draftsKey = "drafts";
const draftPrefix = "draft:";

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
  captured?: Pick<CapturedClip, "sections" | "diagnostics">,
): Draft {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    engineUrl,
    ...(captureTabId === undefined ? {} : { captureTabId }),
    captureUrl: normalizeSourceUrl(metadata.sourceUrl),
    createdAt: now,
    updatedAt: now,
    metadata,
    body,
    originalCapture: structuredClone({ metadata, body, ...captured }),
    ...(captured?.sections ? { sections: captured.sections } : {}),
    ...(captured?.diagnostics ? { diagnostics: captured.diagnostics } : {}),
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

type StorageArea = {
  get(keys?: string | string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

export type SettingsStorage = { local: StorageArea; session: StorageArea };

async function sessionApiKey(storage: SettingsStorage): Promise<string | undefined> {
  const value = (await storage.session.get(apiKeyKey))[apiKeyKey];
  return typeof value === "string" && value ? value : undefined;
}

export async function loadSettings(storage: SettingsStorage): Promise<Settings> {
  const stored = (await storage.local.get(settingsKey))[settingsKey];
  const settings = stored && typeof stored === "object" ? (stored as Settings) : {};
  const { apiKey: persistedKey, ...persisted } = settings;
  if ("apiKey" in settings) {
    if (typeof persistedKey === "string" && persistedKey && !(await sessionApiKey(storage))) {
      await storage.session.set({ [apiKeyKey]: persistedKey });
    }
    await storage.local.set({ [settingsKey]: persisted });
  }
  const apiKey = await sessionApiKey(storage);
  return { ...persisted, ...(apiKey ? { apiKey } : {}) };
}

export async function saveSettings(storage: SettingsStorage, settings: Settings): Promise<void> {
  const { apiKey, ...persisted } = settings;
  await storage.local.set({ [settingsKey]: persisted });
  if (apiKey) await storage.session.set({ [apiKeyKey]: apiKey });
  else await storage.session.remove(apiKeyKey);
}

type DraftStorage = StorageArea;

function isDraft(value: unknown): value is Draft {
  return Boolean(value) && typeof value === "object" && typeof (value as Draft).id === "string";
}

function restoreDraft(value: Draft): Draft {
  const capturedAt = value.metadata?.capturedAt || new Date().toISOString();
  const legacy = value as Draft & { collectionSlug?: unknown; collectionName?: unknown };
  const category =
    typeof legacy.category === "string"
      ? legacy.category
      : typeof legacy.collectionSlug === "string"
        ? legacy.collectionSlug
        : undefined;
  const { collectionSlug: _, collectionName: __, ...current } = legacy;
  return {
    ...current,
    ...(category ? { category } : {}),
    captureUrl: current.captureUrl || normalizeSourceUrl(current.metadata.sourceUrl),
    createdAt: current.createdAt || capturedAt,
    updatedAt: current.updatedAt || capturedAt,
  };
}

async function storedDrafts(storage: DraftStorage): Promise<Record<string, Draft>> {
  const stored = await storage.get();
  const restored = Object.fromEntries(
    Object.entries(stored).flatMap(([key, value]) =>
      key.startsWith(draftPrefix) && isDraft(value) ? [[value.id, restoreDraft(value)]] : [],
    ),
  );
  const storedDraftMap = stored[draftsKey];
  const migratedDrafts =
    storedDraftMap && typeof storedDraftMap === "object"
      ? Object.fromEntries(
          Object.entries(storedDraftMap).flatMap(([id, value]) =>
            isDraft(value) && !restored[id] ? [[id, restoreDraft(value)]] : [],
          ),
        )
      : {};
  const storedSingleDraft = stored[draftKey];
  const migrated =
    isDraft(storedSingleDraft) &&
    !restored[storedSingleDraft.id] &&
    !migratedDrafts[storedSingleDraft.id]
      ? { ...migratedDrafts, [storedSingleDraft.id]: restoreDraft(storedSingleDraft) }
      : migratedDrafts;
  if (Object.keys(migrated).length) {
    await storage.set(
      Object.fromEntries(
        Object.values(migrated).map((draft) => [`${draftPrefix}${draft.id}`, draft]),
      ),
    );
  }
  if (storedDraftMap || storedSingleDraft) await storage.remove([draftsKey, draftKey]);
  return { ...restored, ...migrated };
}

export async function listDrafts(storage: DraftStorage): Promise<Draft[]> {
  return Object.values(await storedDrafts(storage)).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export async function loadDraft(storage: DraftStorage, id: string): Promise<Draft | undefined> {
  return (await storedDrafts(storage))[id];
}

export async function findDraft(
  storage: DraftStorage,
  engineUrl: string,
  captureUrl: string,
): Promise<Draft | undefined> {
  const normalized = normalizeSourceUrl(captureUrl);
  return (await listDrafts(storage)).find(
    (draft) => draft.engineUrl === engineUrl && draft.captureUrl === normalized,
  );
}

export async function saveDraft(storage: DraftStorage, draft: Draft): Promise<void> {
  await storedDrafts(storage);
  const updated = { ...draft, updatedAt: new Date().toISOString() };
  await storage.set({ [`${draftPrefix}${draft.id}`]: updated });
}

export async function clearDraft(storage: DraftStorage, id: string): Promise<void> {
  await storedDrafts(storage);
  await storage.remove(`${draftPrefix}${id}`);
}
