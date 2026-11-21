import type {
  AppAllowance,
  FolderAccess,
  FolderAllowance,
  KeepOutAllowance,
  SiteAllowance,
} from "@shared/device/boundary.ts";
import { isPrivateClass, parseSiteEntry } from "@shared/local-policy/addresses.ts";
import {
  type AppCategory,
  BLOCKED_APP_BUNDLES,
  BLOCKED_APP_NAMES,
  classifyApp,
} from "@shared/local-policy/blocked-apps.ts";
import type { MessageKey } from "../i18n.ts";
import type { AllowancesView, FolderStatus } from "./files-allowances.ts";

type Shown<T> = Omit<T, "digest" | "entered_by">;

export type LocalAllowance =
  | (Shown<FolderAllowance> & { status?: FolderStatus })
  | Shown<SiteAllowance>
  | Shown<AppAllowance>
  | Shown<KeepOutAllowance>;

export interface LocalAllowancesView {
  readonly enabled: boolean;
  readonly items: readonly LocalAllowance[];
}

export const EMPTY_ALLOWANCES: LocalAllowancesView = { enabled: false, items: [] };

export const LOCAL_TABS = ["folders", "websites", "apps", "keepOut"] as const;
export type LocalTab = (typeof LOCAL_TABS)[number];

const TAB_KIND: Record<LocalTab, LocalAllowance["kind"]> = {
  folders: "folder",
  websites: "site",
  apps: "app",
  keepOut: "keep_out",
};

export const TAB_LABEL: Record<LocalTab, MessageKey> = {
  folders: "local.tab.folders",
  websites: "local.tab.websites",
  apps: "local.tab.apps",
  keepOut: "local.tab.keepOut",
};

export function itemsOf(view: LocalAllowancesView, tab: LocalTab): LocalAllowance[] {
  return view.items.filter((item) => item.kind === TAB_KIND[tab]);
}

export function tabCounts(view: LocalAllowancesView): Record<LocalTab, number> {
  return {
    folders: itemsOf(view, "folders").length,
    websites: itemsOf(view, "websites").length,
    apps: itemsOf(view, "apps").length,
    keepOut: itemsOf(view, "keepOut").length,
  };
}

export type RowIcon = "folder" | "website" | "app";
export type Tone = "success" | "warning" | "neutral";

export interface AllowanceRow {
  id: string;
  name: string;
  icon: RowIcon;
  access: MessageKey | null;
  folderAccess: FolderAccess | null;
  status: { tone: Tone; label: MessageKey } | null;
  private: boolean;
  offLimits: boolean;
  removeBody: MessageKey;
}

const STATUS: Record<FolderStatus, { tone: Tone; label: MessageKey }> = {
  available: { tone: "success", label: "local.status.available" },
  changed: { tone: "warning", label: "local.status.changed" },
  missing: { tone: "neutral", label: "local.status.missing" },
};

export function accessLabel(access: FolderAccess): MessageKey {
  return access === "write" ? "local.readWrite" : "local.read";
}

export function rowOf(item: LocalAllowance): AllowanceRow {
  const base = {
    id: item.id,
    access: null,
    folderAccess: null,
    status: null,
    private: false,
    offLimits: false,
  };
  switch (item.kind) {
    case "folder":
      return {
        ...base,
        name: item.display,
        icon: "folder",
        access: accessLabel(item.access),
        folderAccess: item.access,
        status: item.status ? STATUS[item.status] : null,
        removeBody: "local.remove.folderBody",
      };
    case "site":
      return {
        ...base,
        name: item.origin,
        icon: "website",
        private: item.private,
        removeBody: "local.remove.body",
      };
    case "app":
      return { ...base, name: item.display, icon: "app", removeBody: "local.remove.body" };
    case "keep_out":
      return {
        ...base,
        name: item.display,
        icon: item.target === "app" ? "app" : "folder",
        offLimits: true,
        removeBody: "local.remove.keepOutBody",
      };
  }
}

export function rowsOf(view: LocalAllowancesView, tab: LocalTab): AllowanceRow[] {
  return itemsOf(view, tab).map(rowOf);
}

export type SiteEntry = { ok: true; origin: string; private: boolean } | { ok: false };

export function siteEntry(input: string): SiteEntry {
  const parsed = parseSiteEntry(input.trim());
  if (!parsed) return { ok: false };
  return { ok: true, origin: parsed.origin, private: isPrivateClass(parsed.host_class) };
}

export function hasSite(view: LocalAllowancesView, origin: string): boolean {
  return view.items.some((item) => item.kind === "site" && item.origin === origin);
}

export function blockedAppCategories(): AppCategory[] {
  return (Object.keys(BLOCKED_APP_BUNDLES) as AppCategory[]).filter((category) => {
    const bundle = BLOCKED_APP_BUNDLES[category][0] ?? null;
    const name = BLOCKED_APP_NAMES[category][0] ?? null;
    return classifyApp(bundle, name, "darwin").access === "blocked";
  });
}

export function blockedAppLabel(category: AppCategory): MessageKey {
  return `local.blockedApp.${category}` as MessageKey;
}

export function pickErrorKey(code: string): MessageKey {
  if (code === "too_many") return "local.folder.error.tooMany";
  if (code === "not_found") return "local.folder.error.missing";
  return "local.folder.error";
}

export function fromBridge(view: AllowancesView): LocalAllowancesView {
  return {
    enabled: view.personal_enabled,
    items: view.items.map((item): LocalAllowance => {
      if (item.kind === "keep_out")
        return { kind: "keep_out", id: item.id, target: "folder", display: item.display };
      if (item.kind === "site")
        return { kind: "site", id: item.id, origin: item.display, private: item.private };
      if (item.kind === "app") return { kind: "app", id: item.id, display: item.display };
      return {
        kind: "folder",
        id: item.id,
        display: item.display,
        access: item.access ?? "read",
        ...(item.status === null ? {} : { status: item.status }),
      };
    }),
  };
}

export interface LocalState {
  readonly phase: "loading" | "ready" | "error";
  readonly view: LocalAllowancesView;
  readonly busy: boolean;
  readonly problem: MessageKey | null;
}

export const INITIAL_LOCAL: LocalState = {
  phase: "loading",
  view: EMPTY_ALLOWANCES,
  busy: false,
  problem: null,
};

export type LocalEvent =
  | { type: "Requested" }
  | { type: "Loaded"; view: LocalAllowancesView }
  | { type: "Failed" }
  | { type: "PickRefused"; code: string }
  | { type: "PickCancelled" }
  | { type: "ProblemCleared" };

export function localReducer(state: LocalState, event: LocalEvent): LocalState {
  switch (event.type) {
    case "Requested":
      return { ...state, busy: true, problem: null };
    case "Loaded":
      return { phase: "ready", view: event.view, busy: false, problem: null };
    case "Failed":
      return { ...state, phase: "error", busy: false };
    case "PickRefused":
      return { ...state, busy: false, problem: pickErrorKey(event.code) };
    case "PickCancelled":
      return { ...state, busy: false };
    case "ProblemCleared":
      return { ...state, problem: null };
  }
}

export function controlsDisabled(state: LocalState): boolean {
  return state.phase !== "ready" || state.busy || !state.view.enabled;
}
