import { readFile } from "node:fs/promises";

export const CLIPPER_EXTENSION_ID = "odefbnmjeehgfbanpaajiaocliccldma";

export const STORE_SECRETS = [
  "CHROME_WEB_STORE_CLIENT_ID",
  "CHROME_WEB_STORE_CLIENT_SECRET",
  "CHROME_WEB_STORE_REFRESH_TOKEN",
  "CHROME_WEB_STORE_PUBLISHER_ID",
] as const;

export interface StoreCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  publisherId: string;
  extensionId: string;
}

export type UploadState = "SUCCEEDED" | "IN_PROGRESS" | "FAILED" | "NOT_FOUND" | "UNKNOWN";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://chromewebstore.googleapis.com";

export function storeCredentials(
  env: Readonly<Record<string, string | undefined>>,
): StoreCredentials | null {
  const values = STORE_SECRETS.map((name) => env[name]?.trim() ?? "");
  const missing = STORE_SECRETS.filter((_, index) => !values[index]);
  if (missing.length === STORE_SECRETS.length) return null;
  if (missing.length > 0)
    throw new Error(`Chrome Web Store secrets missing: ${missing.join(", ")}`);
  const [clientId = "", clientSecret = "", refreshToken = "", publisherId = ""] = values;
  return { clientId, clientSecret, refreshToken, publisherId, extensionId: CLIPPER_EXTENSION_ID };
}

export function storeUrls(credentials: StoreCredentials) {
  const item = `publishers/${encodeURIComponent(credentials.publisherId)}/items/${encodeURIComponent(credentials.extensionId)}`;
  return {
    token: TOKEN_URL,
    upload: `${API}/upload/v2/${item}:upload`,
    status: `${API}/v2/${item}:fetchStatus`,
    publish: `${API}/v2/${item}:publish`,
  };
}

export function tokenRequestBody(credentials: StoreCredentials): URLSearchParams {
  return new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });
}

export function uploadState(value: unknown): UploadState {
  return value === "SUCCEEDED" ||
    value === "IN_PROGRESS" ||
    value === "FAILED" ||
    value === "NOT_FOUND"
    ? value
    : "UNKNOWN";
}

export interface PublishDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  wait(ms: number): Promise<void>;
  log(line: string): void;
}

async function json(response: Response, step: string): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Chrome Web Store ${step} failed with HTTP ${response.status}`);
  return body;
}

export async function publishToStore(
  credentials: StoreCredentials,
  archive: Uint8Array,
  deps: PublishDeps,
  polls = 30,
): Promise<void> {
  const urls = storeUrls(credentials);
  const token = await json(
    await deps.fetch(urls.token, { method: "POST", body: tokenRequestBody(credentials) }),
    "token exchange",
  );
  if (typeof token.access_token !== "string") {
    throw new Error("Chrome Web Store token exchange returned no access token");
  }
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const uploaded = await json(
    await deps.fetch(urls.upload, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/zip" },
      body: archive,
    }),
    "upload",
  );
  let state = uploadState(uploaded.uploadState);
  for (let attempt = 0; state === "IN_PROGRESS" && attempt < polls; attempt += 1) {
    await deps.wait(10_000);
    const status = await json(await deps.fetch(urls.status, { method: "GET", headers }), "status");
    state = uploadState(status.lastAsyncUploadState);
  }
  if (state !== "SUCCEEDED") throw new Error(`Chrome Web Store upload ended as ${state}`);
  deps.log("Chrome Web Store: upload succeeded");
  await json(await deps.fetch(urls.publish, { method: "POST", headers }), "publish");
  deps.log("Chrome Web Store: submitted for review");
}

if (import.meta.main) {
  const archivePath = process.argv[2];
  if (!archivePath) throw new Error("usage: bun scripts/publish-clipper-store.ts <clipper.zip>");
  const credentials = storeCredentials(process.env);
  if (!credentials) {
    process.stdout.write("Chrome Web Store: no secrets configured, skipped\n");
  } else {
    await publishToStore(credentials, new Uint8Array(await readFile(archivePath)), {
      fetch: (url, init) => fetch(url, init),
      wait: (ms) => Bun.sleep(ms),
      log: (line) => process.stdout.write(`${line}\n`),
    });
  }
}
