interface BadgeTarget {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

export const BADGE_MAX = 99;

export function badgeCount(badge: { count: number } | null | undefined): number {
  const count = badge?.count;
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.floor(count), BADGE_MAX);
}

export async function showAppBadge(
  count: number,
  target: BadgeTarget | undefined = typeof navigator === "undefined" ? undefined : navigator,
): Promise<"set" | "cleared" | "unsupported"> {
  if (!target) return "unsupported";
  try {
    if (count > 0 && typeof target.setAppBadge === "function") {
      await target.setAppBadge(count);
      return "set";
    }
    if (count <= 0 && typeof target.clearAppBadge === "function") {
      await target.clearAppBadge();
      return "cleared";
    }
  } catch {}
  return "unsupported";
}
