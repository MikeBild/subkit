import { HIDDEN_FLAG } from "./autostart.ts";
import { CHANNELS } from "./channel.ts";

const DEFAULT_SCHEME = CHANNELS.production.scheme;

export type DeepLink =
  | { kind: "callback"; code: string; state: string }
  | { kind: "callback-error"; error: string; state: string | null }
  | { kind: "open" };

const TOKEN = /^[A-Za-z0-9._~-]{8,1024}$/;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

export function parseDeepLink(raw: string, scheme: string = DEFAULT_SCHEME): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:`) return null;
  if (url.username || url.password || url.port) return null;
  const target = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  if (target === "open" && !path) return { kind: "open" };
  if (target !== "callback" || path) return null;
  const params = url.searchParams;
  const state = params.get("state");
  const error = params.get("error");
  if (error !== null) {
    if (!ERROR_CODE.test(error)) return null;
    return { kind: "callback-error", error, state: state && TOKEN.test(state) ? state : null };
  }
  const code = params.get("code");
  if (!code || !state || !TOKEN.test(code) || !TOKEN.test(state)) return null;
  if (params.getAll("code").length !== 1 || params.getAll("state").length !== 1) return null;
  return { kind: "callback", code, state };
}

export function findDeepLink(
  argv: readonly string[],
  scheme: string = DEFAULT_SCHEME,
): string | null {
  const prefix = `${scheme}://`;
  for (let i = argv.length - 1; i >= 0; i--) {
    const value = argv[i];
    if (value?.toLowerCase().startsWith(prefix)) return value;
  }
  return null;
}

export type SecondInstanceAction =
  | { kind: "link"; link: string }
  | { kind: "open" }
  | { kind: "none" };

export function secondInstanceAction(
  argv: readonly string[],
  scheme: string = DEFAULT_SCHEME,
): SecondInstanceAction {
  const link = findDeepLink(argv, scheme);
  if (link) return { kind: "link", link };
  return argv.slice(1).includes(HIDDEN_FLAG) ? { kind: "none" } : { kind: "open" };
}
