import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseAppUrl } from "./app-url.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export type AppFile =
  | { ok: true; path: string; contentType: string }
  | { ok: false; status: 404 | 405 };

export function contentTypeFor(path: string): string | null {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? null;
}

export function isInside(root: string, candidate: string): boolean {
  const offset = relative(resolve(root), resolve(candidate));
  return offset !== "" && offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

function segmentsOf(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/")) return null;
  const segments = decoded.slice(1).split("/");
  return segments.every((segment) => SEGMENT.test(segment)) ? segments : null;
}

export function resolveAppFile(method: string, rawUrl: string, root: string): AppFile {
  if (method !== "GET") return { ok: false, status: 405 };
  const url = parseAppUrl(rawUrl);
  const segments = url ? segmentsOf(url.pathname) : null;
  if (!segments) return { ok: false, status: 404 };
  const path = resolve(root, ...segments);
  const contentType = contentTypeFor(path);
  if (!contentType || !isInside(root, path)) return { ok: false, status: 404 };
  return { ok: true, path, contentType };
}
