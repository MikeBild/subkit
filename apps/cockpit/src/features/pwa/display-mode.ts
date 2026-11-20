const INSTALLED_MODES = ["standalone", "window-controls-overlay", "minimal-ui"] as const;

interface DisplayTarget {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: object;
}

export interface AppDeviceState {
  installed: boolean;
  installable: boolean;
  notifications: boolean;
}

export function appDeviceState(input: {
  installed: boolean;
  desktop: boolean;
  secure: boolean;
  notifications: boolean;
}): AppDeviceState {
  const installed = input.installed || input.desktop;
  return {
    installed,
    installable: input.secure && !installed,
    notifications: input.notifications,
  };
}

export function runsInstalled(
  target: DisplayTarget | undefined = typeof window === "undefined" ? undefined : window,
): boolean {
  if (!target) return false;
  if ((target.navigator as { standalone?: unknown } | undefined)?.standalone === true) return true;
  const matchMedia = target.matchMedia;
  if (typeof matchMedia !== "function") return false;
  return INSTALLED_MODES.some((mode) => matchMedia.call(target, `(display-mode: ${mode})`).matches);
}
