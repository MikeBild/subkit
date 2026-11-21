export const COCKPIT_WINDOW = { width: 1280, height: 800, minWidth: 880, minHeight: 600 };

export const WINDOW_BACKGROUND = { light: "#ffffff", dark: "#020618" };

export function windowBackground(dark: boolean): string {
  return dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

export function initialWindowSize(workArea: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(COCKPIT_WINDOW.minWidth, Math.min(COCKPIT_WINDOW.width, workArea.width)),
    height: Math.max(COCKPIT_WINDOW.minHeight, Math.min(COCKPIT_WINDOW.height, workArea.height)),
  };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const CAPTURE_WINDOW = { width: 560 + 32, height: 96 + 200 + 48 };

export function captureBounds(workArea: Rect): Rect {
  return {
    x: Math.round(workArea.x + (workArea.width - CAPTURE_WINDOW.width) / 2),
    y: workArea.y,
    width: CAPTURE_WINDOW.width,
    height: CAPTURE_WINDOW.height,
  };
}

export function overlayBounds(appContent: Rect | null, workArea: Rect): Rect {
  if (appContent) return appContent;
  const { width, height } = initialWindowSize(workArea);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}
