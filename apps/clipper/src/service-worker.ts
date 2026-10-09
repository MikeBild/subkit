import { chromeApi } from "./chrome-api.ts";
import { clearDraft, createDraft, loadDraft, loadSettings, saveDraft } from "./clipper.ts";
import type { CapturedClip, CaptureError, CaptureMode, Draft } from "./types.ts";

const captureErrorKey = "captureError";
const storageAccess = chromeApi.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

const menuText = {
  de: {
    page: "Seite in SubKit sichern",
    selection: "Auswahl in SubKit sichern",
    engineRequired: "Lege vor dem Erfassen eine Engine-Adresse fest.",
    captureFailed: "Die Seite konnte nicht erfasst werden.",
  },
  en: {
    page: "Save page to SubKit",
    selection: "Save selection to SubKit",
    engineRequired: "Set an engine address before capturing.",
    captureFailed: "The page could not be captured.",
  },
};

async function workerText(): Promise<(typeof menuText)["de"]> {
  const settings = await loadSettings(chromeApi.storage.local);
  return menuText[settings.language === "en" ? "en" : "de"];
}

function isExtensionUi(sender: { id?: string; url?: string }): boolean {
  if (sender.id !== chromeApi.runtime.id || !sender.url) return false;
  return ["popup.html", "options.html"].some(
    (path) => sender.url === chromeApi.runtime.getURL(path),
  );
}

async function activeTabId(): Promise<number> {
  const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
  const id = tabs[0]?.id;
  if (id === undefined) throw new Error("No active tab is available.");
  return id;
}

async function saveCaptureError(message: string): Promise<void> {
  const error: CaptureError = { message };
  await chromeApi.storage.local.set({ [captureErrorKey]: error });
}

async function openDraft(): Promise<void> {
  await chromeApi.tabs.create({ url: chromeApi.runtime.getURL("popup.html") });
}

async function captureFromTab(
  tabId: number,
  mode: CaptureMode,
  openDestination: boolean,
): Promise<Draft> {
  await storageAccess;
  const existing = await loadDraft(chromeApi.storage.local);
  if (existing) {
    if (openDestination) await openDraft();
    return existing;
  }
  await chromeApi.scripting.executeScript({ target: { tabId }, files: ["capture.js"] });
  const result = (await chromeApi.tabs.sendMessage(tabId, {
    type: "capture",
    mode,
  })) as CapturedClip;
  const settings = await loadSettings(chromeApi.storage.local);
  if (!settings.engineUrl) {
    await chromeApi.runtime.openOptionsPage();
    throw new Error((await workerText()).engineRequired);
  }
  const draft = createDraft(result.metadata, result.body, settings.engineUrl, tabId);
  await saveDraft(chromeApi.storage.local, draft);
  await chromeApi.storage.local.remove(captureErrorKey);
  if (openDestination) await openDraft();
  return draft;
}

async function startCapture(
  mode: CaptureMode,
  openDestination: boolean,
  discard: boolean,
): Promise<Draft> {
  const existing = await loadDraft(chromeApi.storage.local);
  const tabId = existing?.captureTabId ?? (await activeTabId());
  if (discard) await clearDraft(chromeApi.storage.local);
  return captureFromTab(tabId, mode, openDestination);
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
    await openDraft();
  }
}

void registerMenus();

chromeApi.contextMenus.onClicked.addListener((info, tab) => {
  const mode: CaptureMode = info.menuItemId === "clip-selection" ? "selection" : "article";
  if (tab?.id !== undefined) void runBackgroundCapture(tab.id, mode);
});

chromeApi.commands.onCommand.addListener((command) => {
  if (command !== "capture-current-page") return;
  void activeTabId().then((tabId) => runBackgroundCapture(tabId, "selection"));
});

chromeApi.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isExtensionUi(sender) || !message || typeof message !== "object") return undefined;
  const request = message as { type?: string; mode?: CaptureMode };
  if (request.type === "settings-updated") return registerMenus();
  if (request.type === "start-capture") {
    return startCapture(request.mode === "selection" ? "selection" : "article", false, false);
  }
  if (request.type === "discard-and-capture") {
    return startCapture(request.mode === "selection" ? "selection" : "article", false, true);
  }
  return undefined;
});
