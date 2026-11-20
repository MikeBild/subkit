export const SIDE_PANEL_MIN = 320;
export const SIDE_PANEL_MAX = 560;
export const SIDE_PANEL_DEFAULT = 384;
export const SIDE_PANEL_STEP = 16;
export const SIDE_PANEL_SHEET_BELOW = 900;
export const SIDE_PANEL_STORAGE_KEY = "sk-cockpit-side-panel";

export const SIDE_PANEL_TABS = ["chat", "details", "history"] as const;

export type SidePanelTab = (typeof SIDE_PANEL_TABS)[number];

export interface SidePanelState {
  open: boolean;
  width: number;
  tab: SidePanelTab;
}

export const SIDE_PANEL_INITIAL: SidePanelState = {
  open: false,
  width: SIDE_PANEL_DEFAULT,
  tab: "details",
};

export function clampSidePanelWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDE_PANEL_DEFAULT;
  return Math.min(SIDE_PANEL_MAX, Math.max(SIDE_PANEL_MIN, Math.round(width)));
}

function isTab(value: unknown): value is SidePanelTab {
  return SIDE_PANEL_TABS.includes(value as SidePanelTab);
}

export function parseSidePanelState(raw: string | null | undefined): SidePanelState {
  if (!raw) return SIDE_PANEL_INITIAL;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof SidePanelState, unknown>> | null;
    if (!value || typeof value !== "object") return SIDE_PANEL_INITIAL;
    return {
      open: value.open === true,
      width:
        typeof value.width === "number" ? clampSidePanelWidth(value.width) : SIDE_PANEL_DEFAULT,
      tab: isTab(value.tab) ? value.tab : SIDE_PANEL_INITIAL.tab,
    };
  } catch {
    return SIDE_PANEL_INITIAL;
  }
}

export function serializeSidePanelState(state: SidePanelState): string {
  return JSON.stringify({
    open: state.open,
    width: clampSidePanelWidth(state.width),
    tab: state.tab,
  });
}

export function isSidePanelShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
  return event.key.toLowerCase() === "j";
}

export type SidePanelSubjectType =
  | "workflow"
  | "connector"
  | "skill"
  | "knowledge_source"
  | "task"
  | "file";

export interface SidePanelSubject {
  type: SidePanelSubjectType;
  id: string;
}

const SUBJECT_ROUTES: Record<string, SidePanelSubjectType> = {
  workflows: "workflow",
  connectors: "connector",
  skills: "skill",
  knowledge: "knowledge_source",
  tasks: "task",
  files: "file",
};

const RECORD_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function sidePanelSubject(pathname: string): SidePanelSubject | null {
  const [resource, id, ...rest] = pathname.split("/").filter(Boolean);
  if (!resource || !id || rest.length > 0) return null;
  const type = SUBJECT_ROUTES[resource];
  if (!type || !RECORD_ID.test(id)) return null;
  return { type, id };
}

export function sidePanelTabs(pathname: string): readonly SidePanelTab[] {
  const chat = pathname === "/chat" || pathname.startsWith("/chat/");
  return chat ? SIDE_PANEL_TABS.filter((tab) => tab !== "chat") : SIDE_PANEL_TABS;
}

export function shownSidePanelTab(
  tab: SidePanelTab,
  available: readonly SidePanelTab[],
): SidePanelTab {
  return available.includes(tab) ? tab : "details";
}

export function resizedSidePanelWidth(startWidth: number, startX: number, x: number): number {
  return clampSidePanelWidth(startWidth + (startX - x));
}

export function keyedSidePanelWidth(width: number, key: string): number | null {
  if (key === "ArrowLeft") return clampSidePanelWidth(width + SIDE_PANEL_STEP);
  if (key === "ArrowRight") return clampSidePanelWidth(width - SIDE_PANEL_STEP);
  if (key === "Home") return SIDE_PANEL_MAX;
  if (key === "End") return SIDE_PANEL_MIN;
  return null;
}

export type FactsPresentation = "page" | "docked" | "modal";

export type TechnicalFactsPlace = "details" | "inline";

export function technicalFactsPlace(input: {
  sidePanel: boolean;
  presentation: FactsPresentation;
}): TechnicalFactsPlace {
  if (!input.sidePanel) return "inline";
  return input.presentation === "modal" ? "inline" : "details";
}
