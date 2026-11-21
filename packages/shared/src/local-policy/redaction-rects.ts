import { ALLOW, type PolicyResult, refuse } from "./result.ts";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AxNode {
  readonly role: string;
  readonly subrole?: string | null;
  readonly ref?: string | null;
  readonly label?: string | null;
  readonly value?: string | null;
  readonly secure?: boolean;
  readonly sensitive?: boolean;
  readonly focused?: boolean;
  readonly frame?: Rect | null;
  readonly children?: readonly AxNode[];
}

export type RedactionResult =
  | { readonly ok: true; readonly rects: readonly Rect[] }
  | { readonly ok: false; readonly code: "secure_focus" };

export const SCREENSHOT_MAX_EDGE = 1280;
export const REDACTION_PADDING = 2;
export const SECURE_PLACEHOLDER = "[password, hidden]";

const SECURE_ROLES = new Set(["axsecuretextfield", "password", "passwordbox", "securetextfield"]);

export function isSecureNode(node: AxNode): boolean {
  if (node.secure === true) return true;
  return [node.role, node.subrole].some(
    (role) => typeof role === "string" && SECURE_ROLES.has(role.toLowerCase()),
  );
}

function mustRedact(node: AxNode): boolean {
  return isSecureNode(node) || node.sensitive === true;
}

function validRect(rect: Rect | null | undefined): rect is Rect {
  return (
    rect !== null &&
    rect !== undefined &&
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function walk(node: AxNode, visit: (node: AxNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

export function secureFocus(tree: AxNode): boolean {
  let focused = false;
  walk(tree, (node) => {
    if (node.focused === true && isSecureNode(node)) focused = true;
  });
  return focused;
}

function clip(rect: Rect, window: Rect, padding: number): Rect | null {
  const left = Math.max(0, Math.floor(rect.x - window.x - padding));
  const top = Math.max(0, Math.floor(rect.y - window.y - padding));
  const right = Math.min(window.width, Math.ceil(rect.x - window.x + rect.width + padding));
  const bottom = Math.min(window.height, Math.ceil(rect.y - window.y + rect.height + padding));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function compareRects(a: Rect, b: Rect): number {
  return a.y - b.y || a.x - b.x || a.width - b.width || a.height - b.height;
}

export function redactRects(
  tree: AxNode,
  window: Rect,
  padding = REDACTION_PADDING,
): RedactionResult {
  if (!validRect(window)) return { ok: false, code: "secure_focus" };
  if (secureFocus(tree)) return { ok: false, code: "secure_focus" };
  let unbounded = false;
  const rects = new Map<string, Rect>();
  walk(tree, (node) => {
    if (!mustRedact(node)) return;
    if (!validRect(node.frame)) {
      unbounded = true;
      return;
    }
    const clipped = clip(node.frame, window, padding);
    if (clipped !== null)
      rects.set(`${clipped.x},${clipped.y},${clipped.width},${clipped.height}`, clipped);
  });
  if (unbounded) return { ok: false, code: "secure_focus" };
  return { ok: true, rects: [...rects.values()].sort(compareRects) };
}

export function screenshotPolicy(tree: AxNode, window: Rect): PolicyResult {
  return redactRects(tree, window).ok ? ALLOW : refuse("secure_focus");
}

export interface ScaledSize {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

export function screenshotSize(
  width: number,
  height: number,
  maxEdge = SCREENSHOT_MAX_EDGE,
): ScaledSize {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

export function scaleRects(rects: readonly Rect[], scale: number): Rect[] {
  return rects.map((rect) => {
    const left = Math.floor(rect.x * scale);
    const top = Math.floor(rect.y * scale);
    return {
      x: left,
      y: top,
      width: Math.ceil((rect.x + rect.width) * scale) - left,
      height: Math.ceil((rect.y + rect.height) * scale) - top,
    };
  });
}

export function maskSecureNodes(node: AxNode): AxNode {
  if (isSecureNode(node)) {
    return { role: "password", label: SECURE_PLACEHOLDER, ref: null, children: [] };
  }
  if (!node.children) return node;
  return { ...node, children: node.children.map(maskSecureNodes) };
}
