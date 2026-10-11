import { connectionErrorMessage, IntakeApi } from "./api.ts";
import { chromeApi } from "./chrome-api.ts";
import { loadSettings, normalizeEngineUrl, parseInstallConfig, saveSettings } from "./clipper.ts";
import type { Copy } from "./ui.ts";
import { applyText, copy, language as resolveLanguage } from "./ui.ts";

const form = document.querySelector<HTMLFormElement>("#settings-form");
const engineUrl = document.querySelector<HTMLInputElement>("#engine-url");
const apiKey = document.querySelector<HTMLInputElement>("#api-key");
const language = document.querySelector<HTMLSelectElement>("#language");
const status = document.querySelector<HTMLElement>("#status");
const clearKey = document.querySelector<HTMLButtonElement>("#clear-key");
let initialEngineUrl = "";
let text: Copy = copy.de;

function setStatus(message: string, isError = false): void {
  if (!status) return;
  status.textContent = message;
  status.dataset.error = isError ? "true" : "false";
}

async function installUrl(): Promise<string | undefined> {
  const response = await fetch(chromeApi.runtime.getURL("install-config.json"));
  if (!response.ok) return undefined;
  return parseInstallConfig(await response.json());
}

async function initialize(): Promise<void> {
  const settings = await loadSettings(chromeApi.storage.local);
  const initialUrl = settings.engineUrl || (await installUrl());
  initialEngineUrl = initialUrl || "";
  if (engineUrl) engineUrl.value = initialUrl || "";
  if (apiKey) apiKey.value = settings.apiKey || "";
  if (language) language.value = settings.language || "de";
  const selectedLanguage = resolveLanguage(settings.language);
  text = copy[selectedLanguage];
  document.documentElement.lang = selectedLanguage;
  applyText(text);
  if (settings.engineUrl && settings.apiKey) {
    await verifyConnection(settings.engineUrl, settings.apiKey);
  }
}

async function verifyConnection(engineUrl: string, apiKey: string): Promise<void> {
  setStatus(text.checkingConnection);
  try {
    const result = await new IntakeApi(engineUrl, apiKey).checkConnection();
    if (result.canCollect === false) {
      setStatus(text.missingIntakeWritePermission, true);
    } else if (result.canCollect === true) {
      setStatus(text.connectionVerified);
    } else {
      setStatus(text.connectionReadOnlyVerified);
    }
  } catch (error) {
    setStatus(connectionErrorMessage(error, text), true);
  }
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  let nextUrl: string;
  try {
    nextUrl = normalizeEngineUrl(engineUrl?.value || "");
  } catch {
    setStatus(text.invalidEngine, true);
    return;
  }
  try {
    const origin = new URL(nextUrl).origin;
    const granted = await chromeApi.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) throw new Error(text.permissionDenied);
    const oldSettings = await loadSettings(chromeApi.storage.local);
    const urlChanged = oldSettings.engineUrl !== nextUrl;
    const enteredKey = apiKey?.value.trim() || undefined;
    if (urlChanged && !enteredKey) throw new Error(text.keyRequired);
    await saveSettings(chromeApi.storage.local, {
      engineUrl: nextUrl,
      ...(enteredKey ? { apiKey: enteredKey } : {}),
      language: language?.value === "en" ? "en" : "de",
    });
    if (oldSettings.engineUrl && new URL(oldSettings.engineUrl).origin !== origin) {
      await chromeApi.permissions.remove({
        origins: [`${new URL(oldSettings.engineUrl).origin}/*`],
      });
    }
    initialEngineUrl = nextUrl;
    await chromeApi.runtime.sendMessage({ type: "settings-updated" });
    await verifyConnection(nextUrl, enteredKey || oldSettings.apiKey || "");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : text.invalidEngine, true);
  }
});

engineUrl?.addEventListener("input", () => {
  if (engineUrl.value.trim() !== initialEngineUrl && apiKey) apiKey.value = "";
});

clearKey?.addEventListener("click", async () => {
  const settings = await loadSettings(chromeApi.storage.local);
  const { apiKey: _, ...withoutKey } = settings;
  await saveSettings(chromeApi.storage.local, withoutKey);
  if (apiKey) apiKey.value = "";
  await chromeApi.runtime.sendMessage({ type: "settings-updated" });
  setStatus(text.keyCleared);
});

void initialize();
