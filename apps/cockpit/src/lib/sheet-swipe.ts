export interface SwipePoint {
  x: number;
  y: number;
}

export const SWIPE_DISMISS_DISTANCE = 56;

export function swipeDismisses(
  side: "left" | "right",
  start: SwipePoint,
  end: SwipePoint,
): boolean {
  const horizontal = end.x - start.x;
  const toward = side === "left" ? -horizontal : horizontal;
  return toward >= SWIPE_DISMISS_DISTANCE && toward > Math.abs(end.y - start.y) * 1.5;
}
