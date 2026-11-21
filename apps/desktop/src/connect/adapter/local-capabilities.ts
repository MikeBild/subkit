import type { FolderAccess } from "@shared/device/boundary.ts";
import type { LocalBridge } from "../../shared/ipc.ts";
import {
  EMPTY_ALLOWANCES,
  fromBridge,
  hasSite,
  type LocalAllowancesView,
  siteEntry,
} from "../../shared/local/capabilities-model.ts";

export interface PickFolderOptions {
  access: FolderAccess;
  keepOut: boolean;
}

export type PickResult =
  | { status: "cancelled" }
  | { status: "refused"; code: string }
  | { status: "added"; id: string; view: LocalAllowancesView };

export interface LocalCapabilitiesPort {
  listAllowances(): Promise<LocalAllowancesView>;
  pickFolder(options: PickFolderOptions): Promise<PickResult>;
  removeAllowance(id: string): Promise<LocalAllowancesView>;
  setPersonalEnabled(enabled: boolean): Promise<LocalAllowancesView>;
  setAccess: ((id: string, access: FolderAccess) => Promise<LocalAllowancesView>) | null;
  addSite: ((origin: string) => Promise<LocalAllowancesView>) | null;
  addApp: (() => Promise<PickResult>) | null;
}

const BRIDGE_METHODS = [
  "pickFolder",
  "listAllowances",
  "removeAllowance",
  "setAccess",
  "setPersonalEnabled",
  "addSite",
  "addApp",
];

export function deviceBridgeOf(bridge: unknown): LocalBridge | null {
  const local =
    bridge && typeof bridge === "object" ? (bridge as { local?: unknown }).local : undefined;
  if (!local || typeof local !== "object") return null;
  const methods = local as Record<string, unknown>;
  return BRIDGE_METHODS.every((name) => typeof methods[name] === "function")
    ? (local as LocalBridge)
    : null;
}

export function createMockLocalCapabilities(
  seed: LocalAllowancesView = EMPTY_ALLOWANCES,
): LocalCapabilitiesPort {
  let view = seed;
  let counter = 0;
  const answer = () => Promise.resolve(view);
  return {
    listAllowances: answer,
    pickFolder: () => Promise.resolve({ status: "cancelled" }),
    removeAllowance(id) {
      view = { ...view, items: view.items.filter((item) => item.id !== id) };
      return answer();
    },
    setPersonalEnabled(enabled) {
      view = { ...view, enabled };
      return answer();
    },
    setAccess(id, access) {
      view = {
        ...view,
        items: view.items.map((item) =>
          item.kind === "folder" && item.id === id ? { ...item, access } : item,
        ),
      };
      return answer();
    },
    addSite(origin) {
      const entry = siteEntry(origin);
      if (entry.ok && !hasSite(view, entry.origin)) {
        counter += 1;
        const site = {
          kind: "site" as const,
          id: `site_${counter}`,
          origin: entry.origin,
          private: entry.private,
        };
        view = { ...view, items: [...view.items, site] };
      }
      return answer();
    },
    addApp: () => Promise.resolve({ status: "cancelled" }),
  };
}

export function createLocalCapabilities(bridge: unknown): LocalCapabilitiesPort {
  const device = deviceBridgeOf(bridge);
  if (!device) return createMockLocalCapabilities();
  return {
    listAllowances: async () => fromBridge(await device.listAllowances()),
    async pickFolder(options) {
      const result = await device.pickFolder(options);
      return result.status === "added" ? { ...result, view: fromBridge(result.view) } : result;
    },
    removeAllowance: async (id) => fromBridge(await device.removeAllowance(id)),
    setPersonalEnabled: async (enabled) => fromBridge(await device.setPersonalEnabled(enabled)),
    setAccess: async (id, access) => fromBridge(await device.setAccess(id, access)),
    addSite: async (origin) => fromBridge(await device.addSite(origin)),
    async addApp() {
      const result = await device.addApp();
      return result.status === "added" ? { ...result, view: fromBridge(result.view) } : result;
    },
  };
}
