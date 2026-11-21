import { type Rect, redactRects } from "@shared/local-policy/redaction-rects.ts";
import { type RawNode, toAxNode } from "./computer-tree.ts";

export const SHADOW_TOLERANCE_PX = 2;

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export interface RedactionInput {
  readonly tree: RawNode;
  readonly window: Rect;
  readonly image: ImageSize;
  readonly scale: number;
}

export type RedactionPlan =
  | { readonly ok: true; readonly rects: readonly Rect[] }
  | { readonly ok: false; readonly code: "secure_focus" | "stale" };

export function toImageRects(
  rects: readonly Rect[],
  window: Rect,
  image: ImageSize,
  scale: number,
): Rect[] | null {
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const slackX = image.width - window.width * scale;
  const slackY = image.height - window.height * scale;
  if (slackX < -SHADOW_TOLERANCE_PX || slackY < -SHADOW_TOLERANCE_PX) return null;
  const spreadX = Math.max(0, Math.ceil(slackX));
  const spreadY = Math.max(0, Math.ceil(slackY));
  return rects.flatMap((rect) => {
    const left = Math.max(0, Math.floor(rect.x * scale));
    const top = Math.max(0, Math.floor(rect.y * scale));
    const right = Math.min(image.width, Math.ceil((rect.x + rect.width) * scale) + spreadX);
    const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height) * scale) + spreadY);
    if (right <= left || bottom <= top) return [];
    return [{ x: left, y: top, width: right - left, height: bottom - top }];
  });
}

export function redactionPlan(input: RedactionInput): RedactionPlan {
  const secure = redactRects(toAxNode(input.tree), input.window);
  if (!secure.ok) return { ok: false, code: "secure_focus" };
  const rects = toImageRects(secure.rects, input.window, input.image, input.scale);
  return rects === null ? { ok: false, code: "stale" } : { ok: true, rects };
}
