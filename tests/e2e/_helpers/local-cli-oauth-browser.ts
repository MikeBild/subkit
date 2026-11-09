import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface LocalCliOAuthBrowser {
  env: Record<string, string>;
  cleanup: () => void;
}

export const LOCAL_CLI_OAUTH_BROWSER_SUPPORTED =
  process.platform === "darwin" || process.platform === "linux";

export function createLocalCliOAuthBrowser(input: {
  engineUrl: string;
  apiKey: string;
}): LocalCliOAuthBrowser {
  const engine = new URL(input.engineUrl);
  if (!isLoopback(engine)) throw new Error("local OAuth fixture requires a loopback engine");
  if (!LOCAL_CLI_OAUTH_BROWSER_SUPPORTED) {
    throw new Error("local OAuth browser fixture supports POSIX launchers only");
  }

  const dir = mkdtempSync(path.join(tmpdir(), "sk-e2e-oauth-browser-"));
  const driver = path.join(dir, "driver.ts");
  writeFileSync(driver, DRIVER, "utf8");
  for (const launcher of ["open", "xdg-open"]) {
    writeFileSync(
      path.join(dir, launcher),
      `#!/bin/sh\nexec "${process.execPath}" "${driver}" "$1"\n`,
      { encoding: "utf8", mode: 0o700 },
    );
  }

  return {
    env: {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      SK_E2E_OAUTH_ENGINE_ORIGIN: engine.origin,
      SK_E2E_OAUTH_API_KEY: input.apiKey,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

const DRIVER = `
const engineOrigin = process.env.SK_E2E_OAUTH_ENGINE_ORIGIN;
const apiKey = process.env.SK_E2E_OAUTH_API_KEY;
if (!engineOrigin || !apiKey) throw new Error("missing local OAuth driver configuration");
const engine = new URL(engineOrigin);
if (engine.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(engine.hostname)) {
  throw new Error("OAuth engine must be loopback");
}
const sameEngine = (raw) => new URL(raw, engine).origin === engine.origin;
const loopback = (raw) => {
  const u = new URL(raw);
  return u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname);
};
const onlyEngine = (raw) => {
  const u = new URL(raw, engine);
  if (!sameEngine(u)) throw new Error("refused non-engine OAuth URL");
  return u;
};
let cookie = "";
const request = async (raw, init = {}) => {
  const u = onlyEngine(raw);
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(u, {...init, headers, redirect: "manual"});
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0] || "";
  return response;
};
const location = (response) => {
  const raw = response.headers.get("location");
  if (!raw) throw new Error("OAuth response omitted redirect");
  return new URL(raw, engine);
};
const hidden = (html, name) => {
  const re = new RegExp('<input[^>]+name="' + name + '"[^>]+value="([^"]*)"');
  const value = html.match(re)?.[1];
  if (!value) throw new Error("OAuth consent omitted " + name);
  return value;
};
const authorizationUrl = onlyEngine(process.argv[2] || "");
let response = await request(authorizationUrl);
if (response.status !== 302) throw new Error("OAuth authorize did not require local sign-in");
const login = location(response);
if (login.pathname !== "/v1/identity/login/start") throw new Error("OAuth redirect was not local login");
const loginState = login.searchParams.get("login_state");
if (!loginState) throw new Error("OAuth login state missing");
response = await request(new URL("/v1/identity/login/start", engine), {
  method: "POST",
  headers: {"content-type": "application/x-www-form-urlencoded"},
  body: new URLSearchParams({provider: "api-key", login_state: loginState, api_key: apiKey}),
});
if (response.status !== 302 || !cookie) throw new Error("local API-key browser sign-in failed");
response = await request(location(response));
if (response.status !== 200) throw new Error("OAuth consent was not rendered");
const html = await response.text();
if (!html.includes("Allow access")) throw new Error("OAuth consent chrome missing");
const body = new URLSearchParams({
  csrf_token: hidden(html, "csrf_token"),
  client_id: hidden(html, "client_id"),
  redirect_uri: hidden(html, "redirect_uri"),
  resource: hidden(html, "resource"),
  state: hidden(html, "state"),
  decision: "approve",
  scope: "sk:login",
});
response = await request(new URL("/v1/oauth/authorize/decision", engine), {
  method: "POST",
  headers: {"content-type": "application/x-www-form-urlencoded"},
  body,
});
if (response.status !== 302) throw new Error("OAuth approval did not redirect");
const callback = location(response);
if (!loopback(callback) || callback.pathname !== "/callback") throw new Error("refused non-loopback CLI callback");
let callbackResponse = await fetch(callback, {redirect: "manual"});
if (callbackResponse.status !== 303) throw new Error("CLI callback did not acknowledge authorization");
const done = new URL(callbackResponse.headers.get("location") || "", callback);
if (!loopback(done) || done.pathname !== "/signed-in") throw new Error("refused non-loopback CLI completion page");
callbackResponse = await fetch(done, {redirect: "manual"});
if (callbackResponse.status !== 200) throw new Error("CLI completion page failed");
`;
