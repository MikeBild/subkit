import type { CaptureMode } from "./types.ts";

type StorageRecord = Record<string, unknown>;

interface ChromeApi {
  storage: {
    local: {
      get(keys?: string | string[] | StorageRecord): Promise<StorageRecord>;
      set(items: StorageRecord): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      setAccessLevel(access: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
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
        ) => unknown,
      ): void;
    };
    openOptionsPage(): Promise<void>;
  };
  tabs: {
    query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<{ id?: number }[]>;
    create(createProperties: { url: string }): Promise<void>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
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
  | { type: "start-capture"; mode: CaptureMode }
  | { type: "discard-and-capture"; mode: CaptureMode }
  | { type: "settings-updated" };
