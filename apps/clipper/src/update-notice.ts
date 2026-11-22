import { chromeApi } from "./chrome-api.ts";
import { type Copy, updateNoticeText } from "./ui.ts";
import { currentUpdateCheck, type InstallType, updateCheckKey, updateNotice } from "./update.ts";

async function installType(): Promise<InstallType | undefined> {
  try {
    return (await chromeApi.management.getSelf()).installType;
  } catch {
    return undefined;
  }
}

async function fetchDescriptor(url: string): Promise<unknown> {
  const response = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new Error(`descriptor ${response.status}`);
  return response.json();
}

export async function showUpdateNotice(engineUrl: string | undefined, values: Copy): Promise<void> {
  const notice = document.querySelector<HTMLElement>("#update-notice");
  const label = document.querySelector<HTMLElement>("#update-text");
  const link = document.querySelector<HTMLAnchorElement>("#update-link");
  if (!notice || !label || !link || !engineUrl) return;
  try {
    const check = await currentUpdateCheck(engineUrl, {
      load: async () => (await chromeApi.storage.local.get(updateCheckKey))[updateCheckKey],
      store: (next) => chromeApi.storage.local.set({ [updateCheckKey]: next }),
      fetchDescriptor,
      now: () => Date.now(),
    });
    const next = updateNotice({
      installed: chromeApi.runtime.getManifest().version,
      installType: await installType(),
      check,
    });
    notice.hidden = !next;
    if (!next) return;
    label.textContent = updateNoticeText(values, next.version);
    link.href = next.downloadUrl;
  } catch {
    notice.hidden = true;
  }
}
