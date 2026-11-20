export const LINK_PROTOCOL = "web+subkit";
export const LINK_PARAM = "link";

const SECTIONS: Readonly<Record<string, { path: string; record: boolean }>> = {
  open: { path: "/", record: false },
  overview: { path: "/", record: false },
  chat: { path: "/chat", record: true },
  tasks: { path: "/tasks", record: true },
  inbox: { path: "/intake", record: true },
  intake: { path: "/intake", record: true },
  workflows: { path: "/workflows", record: true },
  connectors: { path: "/connectors", record: true },
  knowledge: { path: "/knowledge", record: true },
  skills: { path: "/skills", record: true },
  files: { path: "/files", record: true },
  settings: { path: "/settings", record: false },
};
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LINK_MAX = 512;

export function deepLinkRoute(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length > LINK_MAX) return null;
  const prefix = `${LINK_PROTOCOL}:`;
  if (!raw.toLowerCase().startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length).replace(/^\/\//, "");
  if (/[?#@%\\\s]/.test(rest)) return null;
  const parts = rest.replace(/\/+$/, "").split("/");
  const section = Object.hasOwn(SECTIONS, parts[0] ?? "") ? SECTIONS[parts[0] ?? ""] : undefined;
  if (!section || parts.length > 2) return null;
  const id = parts[1];
  if (id === undefined) return section.path;
  if (!section.record || !RECORD_ID.test(id) || id.includes("..")) return null;
  return `${section.path}/${id}`;
}

export function launchRoute(target: string | null | undefined, base: string): string | null {
  if (typeof target !== "string" || !target) return null;
  let url: URL;
  try {
    url = new URL(target, "https://subkit.invalid");
  } catch {
    return null;
  }
  if (url.searchParams.has(LINK_PARAM)) return deepLinkRoute(url.searchParams.get(LINK_PARAM));
  if (url.pathname === base || url.pathname === `${base}/`) return null;
  if (!url.pathname.startsWith(`${base}/`)) return null;
  const path = url.pathname.slice(base.length);
  if (path.startsWith("/api/") || path.startsWith("/incoming/")) return null;
  return `${path}${url.search}${url.hash}`;
}
