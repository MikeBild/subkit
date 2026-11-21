export const START_LAYOUT_KEY = "sk-cockpit-start-layout";

export interface StartLayout {
  leftCollapsed: boolean;
  rightOpen: boolean | null;
}

export const START_LAYOUT_DEFAULT: StartLayout = { leftCollapsed: false, rightOpen: null };

export function parseStartLayout(raw: string | null | undefined): StartLayout {
  if (!raw) return START_LAYOUT_DEFAULT;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object") return START_LAYOUT_DEFAULT;
    return {
      leftCollapsed: value.leftCollapsed === true,
      rightOpen: typeof value.rightOpen === "boolean" ? value.rightOpen : null,
    };
  } catch {
    return START_LAYOUT_DEFAULT;
  }
}

export function startPanelOpen(remembered: boolean, layout: StartLayout): boolean {
  return layout.rightOpen ?? remembered;
}

export function readStartLayout(): StartLayout {
  try {
    return parseStartLayout(window.localStorage.getItem(START_LAYOUT_KEY));
  } catch {
    return START_LAYOUT_DEFAULT;
  }
}

export function writeStartLayout(layout: StartLayout): void {
  try {
    window.localStorage.setItem(START_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    return;
  }
}
