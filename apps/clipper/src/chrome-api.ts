import { type SendResponse, unwrapResponse } from "./messaging.ts";
import type { CaptureMode, Draft } from "./types.ts";
import type { InstallType } from "./update.ts";

type StorageRecord = Record<string, unknown>;

interface ChromeApi {
  storage: {
    local: {
      get(keys?: string | string[] | StorageRecord): Promise<StorageRecord>;
      set(items: StorageRecord): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      setAccessLevel(access: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
    };
    session: {
      get(keys?: string | string[] | StorageRecord): Promise<StorageRecord>;
      set(items: StorageRecord): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  };
  runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: { id?: string; url?: string; tab?: { id?: number } },
          sendResponse: SendResponse,
        ) => unknown,
      ): void;
    };
    openOptionsPage(): Promise<void>;
    getManifest(): { version: string };
  };
  management: {
    getSelf(): Promise<{ installType: InstallType }>;
  };
  tabs: {
    query(queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
    }): Promise<{ id?: number; url?: string; windowId?: number }[]>;
    get(tabId: number): Promise<{ id?: number; url?: string; windowId?: number }>;
    create(createProperties: { url: string }): Promise<void>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    onActivated: {
      addListener(listener: (activeInfo: { tabId: number; windowId: number }) => void): void;
    };
    onUpdated: {
      addListener(
        listener: (tabId: number, changeInfo: { url?: string }, tab: { url?: string }) => void,
      ): void;
    };
  };
  scripting: {
    executeScript(details: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
  contextMenus: {
    removeAll(): Promise<void>;
    create(properties: { id: string; title: string; contexts: string[] }): void;
    onClicked: {
      addListener(listener: (info: { menuItemId: string }, tab?: { id?: number }) => void): void;
    };
  };
  commands: {
    onCommand: { addListener(listener: (command: string) => void): void };
  };
  permissions: {
    request(permission: { origins: string[] }): Promise<boolean>;
    remove(permission: { origins: string[] }): Promise<boolean>;
  };
}

export const chromeApi = (globalThis as unknown as { chrome: ChromeApi }).chrome;

export type RuntimeMessage =
  | { type: "capture"; mode: CaptureMode }
  | { type: "start-capture"; mode: CaptureMode; draftId?: string; captureTabId?: number }
  | { type: "discard-and-capture"; mode: CaptureMode; draftId?: string; captureTabId?: number }
  | { type: "list-drafts" }
  | { type: "load-draft"; draftId: string }
  | { type: "save-draft"; draft: Draft }
  | { type: "clear-draft"; draftId: string }
  | { type: "settings-updated" };

export async function sendRuntimeMessage<Value = unknown>(message: RuntimeMessage): Promise<Value> {
  return unwrapResponse<Value>(await chromeApi.runtime.sendMessage(message));
}
