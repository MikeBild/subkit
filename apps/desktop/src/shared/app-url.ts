export const APP_SCHEME = "subkit-app";
export const APP_HOST = "shell";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const CONNECT_PAGE = "index.html";
export const CONNECT_URL = `${APP_ORIGIN}/${CONNECT_PAGE}`;

export const CONNECT_CSP = [
  "default-src 'none'",
  `script-src ${APP_ORIGIN}`,
  `style-src ${APP_ORIGIN}`,
  `font-src ${APP_ORIGIN}`,
  `img-src ${APP_ORIGIN}`,
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function parseAppUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST) return null;
  if (url.port || url.username || url.password) return null;
  return url;
}

export function isConnectUrl(raw: string): boolean {
  return parseAppUrl(raw)?.pathname === `/${CONNECT_PAGE}`;
}
