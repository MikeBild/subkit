import { lstat, readFile, realpath } from "node:fs/promises";
import { protocol, type Session } from "electron";
import { belowRoot, resolveAppFile } from "../shared/app-files.ts";
import { APP_SCHEME, CONNECT_CSP } from "../shared/app-url.ts";

const COMMON_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": CONNECT_CSP,
};

function refuse(status: number): Response {
  return new Response(null, { status, headers: COMMON_HEADERS });
}

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

export interface AppImage {
  path: string;
  read(): Uint8Array | null;
}

function serveImage(image: AppImage): Response {
  const body = image.read();
  if (!body) return refuse(404);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { ...COMMON_HEADERS, "content-type": "image/png" },
  });
}

export function serveAppFiles(session: Session, root: string, image?: AppImage): void {
  session.protocol.handle(APP_SCHEME, async (request) => {
    if (image && request.method === "GET" && new URL(request.url).pathname === `/${image.path}`)
      return serveImage(image);
    const file = resolveAppFile(request.method, request.url, root);
    if (!file.ok) return refuse(file.status);
    try {
      if (!(await lstat(file.path)).isFile()) return refuse(404);
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file.path)]);
      if (!belowRoot(realRoot, realFile)) return refuse(404);
      const body = await readFile(realFile);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { ...COMMON_HEADERS, "content-type": file.contentType },
      });
    } catch {
      return refuse(404);
    }
  });
}
