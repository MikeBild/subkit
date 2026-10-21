import { chromeApi } from "./chrome-api.ts";
import {
  clearDraft,
  createDraft,
  findDraft,
  listDrafts,
  loadDraft,
  loadSettings,
  normalizeSourceUrl,
  saveDraft,
} from "./clipper.ts";
import type { CapturedClip, CaptureError, CaptureMode, Draft } from "./types.ts";
import { type WorkerCopy, workerCopy } from "./ui.ts";

const captureErrorKey = "captureError";
const storageAccess = chromeApi.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let draftWrites = Promise.resolve();

async function workerText(): Promise<WorkerCopy> {
  const settings = await loadSettings(chromeApi.storage.local);
  return workerCopy[settings.language === "en" ? "en" : "de"];
}

function popupRoute(sender: { url?: string }): { draftId?: string; tabId?: number } | undefined {
  if (!sender.url) return undefined;
  const url = new URL(sender.url);
  if (url.pathname !== new URL(chromeApi.runtime.getURL("popup.html")).pathname) return undefined;
  const allowed = new Set(["draft", "tab"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return undefined;
  const draftId = url.searchParams.get("draft") || undefined;
  if (draftId && !/^[a-z0-9_-]{1,128}$/i.test(draftId)) return undefined;
  const tab = url.searchParams.get("tab");
  if (tab && !/^[1-9][0-9]*$/.test(tab)) return undefined;
  return { ...(draftId ? { draftId } : {}), ...(tab ? { tabId: Number(tab) } : {}) };
}

function isExtensionUi(sender: { id?: string; url?: string }): boolean {
  if (sender.id !== chromeApi.runtime.id || !sender.url) return false;
  const url = new URL(sender.url);
  const popup = new URL(chromeApi.runtime.getURL("popup.html"));
  const options = new URL(chromeApi.runtime.getURL("options.html"));
  return (
    (url.origin === popup.origin &&
      url.pathname === popup.pathname &&
      Boolean(popupRoute(sender))) ||
    (url.origin === options.origin && url.pathname === options.pathname && !url.search)
  );
}

async function activeTabId(): Promise<number> {
  const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
  const id = tabs[0]?.id;
  if (id === undefined) throw new Error((await workerText()).noActiveTab);
  return id;
}

async function saveCaptureError(message: string): Promise<void> {
  const error: CaptureError = { message };
  await chromeApi.storage.local.set({ [captureErrorKey]: error });
}

async function openDraft(draftId?: string, tabId?: number): Promise<void> {
  const url = new URL(chromeApi.runtime.getURL("popup.html"));
  if (draftId) url.searchParams.set("draft", draftId);
  if (tabId) url.searchParams.set("tab", String(tabId));
  await chromeApi.tabs.create({ url: url.toString() });
}

function isDraft(value: unknown): value is Draft {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Draft).id === "string" &&
    typeof (value as Draft).engineUrl === "string" &&
    typeof (value as Draft).captureUrl === "string" &&
    typeof (value as Draft).createdAt === "string" &&
    typeof (value as Draft).updatedAt === "string" &&
    ((value as Draft).writeRevision === undefined ||
      (Number.isSafeInteger((value as Draft).writeRevision) && (value as Draft).writeRevision! > 0))
  );
}

function queueDraftWrite(operation: () => Promise<void>): Promise<void> {
  draftWrites = draftWrites.then(operation, operation);
  return draftWrites;
}

async function savePopupDraft(next: Draft): Promise<void> {
  const existing = await loadDraft(chromeApi.storage.local, next.id);
  if (!existing) throw new Error((await workerText()).draftMissing);
  if (
    existing.engineUrl !== next.engineUrl ||
    existing.captureUrl !== next.captureUrl ||
    existing.createdAt !== next.createdAt
  ) {
    throw new Error((await workerText()).draftIdentityChanged);
  }
  const existingRevision = existing.writeRevision || 0;
  if (next.writeRevision !== undefined && next.writeRevision <= existingRevision) return;
  await saveDraft(chromeApi.storage.local, {
    ...next,
    writeRevision: next.writeRevision || existingRevision + 1,
    originalCapture: existing.originalCapture,
  });
}

async function tabUrl(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chromeApi.tabs.get(tabId);
    return tab.url ? normalizeSourceUrl(tab.url) : undefined;
  } catch {
    return undefined;
  }
}

async function capturePage(tabId: number, mode: CaptureMode): Promise<CapturedClip> {
  const urlAtStart = await tabUrl(tabId);
  try {
    await chromeApi.scripting.executeScript({ target: { tabId }, files: ["capture.js"] });
    return (await chromeApi.tabs.sendMessage(tabId, { type: "capture", mode })) as CapturedClip;
  } catch {
    const text = await workerText();
    const urlAfter = await tabUrl(tabId);
    throw new Error(urlAtStart && urlAfter !== urlAtStart ? text.pageChanged : text.captureFailed);
  }
}

async function captureFromTab(
  tabId: number,
  mode: CaptureMode,
  openDestination: boolean,
  replaceDraftId?: string,
): Promise<Draft> {
  await draftWrites;
  await storageAccess;
  const settingsAtStart = await loadSettings(chromeApi.storage.local);
  if (!settingsAtStart.engineUrl) {
    await chromeApi.runtime.openOptionsPage();
    throw new Error((await workerText()).engineRequired);
  }
  const result = await capturePage(tabId, mode);
  const capturedUrl = normalizeSourceUrl(result.metadata.sourceUrl);
  const tab = await chromeApi.tabs.get(tabId);
  if (!tab.url || normalizeSourceUrl(tab.url) !== capturedUrl) {
    throw new Error((await workerText()).pageChanged);
  }
  const settings = await loadSettings(chromeApi.storage.local);
  if (settings.engineUrl !== settingsAtStart.engineUrl) {
    throw new Error((await workerText()).engineChanged);
  }
  const existing = await findDraft(chromeApi.storage.local, settingsAtStart.engineUrl, capturedUrl);
  if (existing && existing.id !== replaceDraftId) {
    const recoverEmptyCapture =
      mode === "auto" &&
      !existing.body.trim() &&
      !existing.originalCapture?.body.trim() &&
      !existing.intakeAttempt &&
      !existing.attempt &&
      existing.diagnostics?.some((item) =>
        ["selection_unavailable", "main_content_unavailable"].includes(item.code),
      ) &&
      Boolean(result.body.trim());
    const draft = recoverEmptyCapture
      ? {
          ...existing,
          ...result,
          metadata: { ...result.metadata, title: existing.metadata.title },
          originalCapture: result,
          diagnostics: result.diagnostics || [],
          captureTabId: tabId,
          writeRevision: (existing.writeRevision || 0) + 1,
        }
      : existing.captureTabId === tabId
        ? existing
        : { ...existing, captureTabId: tabId };
    if (draft !== existing) await queueDraftWrite(() => saveDraft(chromeApi.storage.local, draft));
    if (openDestination) await openDraft(draft.id);
    return draft;
  }
  const captured = createDraft(
    result.metadata,
    result.body,
    settingsAtStart.engineUrl,
    tabId,
    result,
  );
  const draft =
    existing && existing.id === replaceDraftId
      ? {
          ...captured,
          id: existing.id,
          createdAt: existing.createdAt,
          ...(existing.writeRevision ? { writeRevision: existing.writeRevision } : {}),
        }
      : captured;
  await queueDraftWrite(() => saveDraft(chromeApi.storage.local, draft));
  await chromeApi.storage.local.remove(captureErrorKey);
  if (openDestination) await openDraft(draft.id);
  return draft;
}

async function startCapture(
  mode: CaptureMode,
  openDestination: boolean,
  replaceDraftId: string | undefined,
  requestedTabId: number | undefined,
  sender: { tab?: { id?: number; url?: string } },
): Promise<Draft> {
  await draftWrites;
  const existing = replaceDraftId
    ? await loadDraft(chromeApi.storage.local, replaceDraftId)
    : undefined;
  const senderTabId = sender.tab?.url?.startsWith(chromeApi.runtime.getURL("popup.html"))
    ? undefined
    : sender.tab?.id;
  const tabId = requestedTabId ?? senderTabId ?? existing?.captureTabId ?? (await activeTabId());
  return captureFromTab(tabId, mode, openDestination, replaceDraftId);
}

async function registerMenus(): Promise<void> {
  const text = await workerText();
  await chromeApi.contextMenus.removeAll();
  chromeApi.contextMenus.create({ id: "clip-page", title: text.page, contexts: ["page"] });
  chromeApi.contextMenus.create({
    id: "clip-selection",
    title: text.selection,
    contexts: ["selection"],
  });
}

async function runBackgroundCapture(tabId: number, mode: CaptureMode): Promise<void> {
  try {
    await captureFromTab(tabId, mode, true);
  } catch (error) {
    await saveCaptureError(
      error instanceof Error ? error.message : (await workerText()).captureFailed,
    );
    await openDraft(undefined, tabId);
  }
}

void registerMenus();

chromeApi.contextMenus.onClicked.addListener((info, tab) => {
  const mode: CaptureMode = info.menuItemId === "clip-selection" ? "selection" : "article";
  if (tab?.id !== undefined) void runBackgroundCapture(tab.id, mode);
});

chromeApi.commands.onCommand.addListener((command) => {
  if (command !== "capture-current-page") return;
  void activeTabId().then((tabId) => runBackgroundCapture(tabId, "auto"));
});

chromeApi.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isExtensionUi(sender) || !message || typeof message !== "object") return undefined;
  const request = message as {
    type?: string;
    mode?: CaptureMode;
    draftId?: string;
    captureTabId?: number;
    draft?: unknown;
  };
  const route = popupRoute(sender);
  const draftId = request.draftId || route?.draftId;
  const requestedTabId =
    typeof request.captureTabId === "number" &&
    Number.isSafeInteger(request.captureTabId) &&
    request.captureTabId > 0
      ? request.captureTabId
      : route?.tabId;
  if (request.type === "settings-updated") return registerMenus();
  if (request.type === "save-draft") {
    if (!isDraft(request.draft)) {
      return workerText().then((text) => Promise.reject(new Error(text.draftInvalid)));
    }
    const draft = request.draft;
    return queueDraftWrite(() => savePopupDraft(draft));
  }
  if (request.type === "load-draft") {
    return draftWrites.then(() => loadDraft(chromeApi.storage.local, request.draftId || ""));
  }
  if (request.type === "clear-draft") {
    return queueDraftWrite(() => clearDraft(chromeApi.storage.local, request.draftId || ""));
  }
  if (request.type === "start-capture") {
    return startCapture(
      request.mode === "selection" ? "selection" : request.mode === "auto" ? "auto" : "article",
      false,
      undefined,
      requestedTabId,
      sender,
    );
  }
  if (request.type === "discard-and-capture") {
    return startCapture(
      request.mode === "selection" ? "selection" : request.mode === "auto" ? "auto" : "article",
      false,
      draftId,
      requestedTabId,
      sender,
    );
  }
  if (request.type === "list-drafts")
    return draftWrites.then(() => listDrafts(chromeApi.storage.local));
  return undefined;
});
