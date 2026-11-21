import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  agentBrowserDownload,
  BROWSER_TARGETS,
  BrowserPinSchema,
  type BrowserTarget,
} from "../src/shared/local/browser-runtime.ts";
import pinJson from "../vendor/agent-browser.json";

const root = resolve(import.meta.dir, "..");
export const AGENT_BROWSER_RESOURCES = join(root, "resources/agent-browser");
const pin = BrowserPinSchema.parse(pinJson);

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

async function verified(path: string, bytes: number, sha256: string): Promise<boolean> {
  const file = Bun.file(path);
  return (await file.exists()) && file.size === bytes && (await sha256Of(path)) === sha256;
}

export async function fetchAgentBrowser(target: BrowserTarget): Promise<string> {
  const pinned = agentBrowserDownload(pin, target);
  const folder = join(AGENT_BROWSER_RESOURCES, target);
  const binary = join(folder, "agent-browser");
  if (await verified(binary, pinned.bytes, pinned.sha256)) return binary;
  await mkdir(folder, { recursive: true });
  const response = await fetch(pinned.url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`GET ${pinned.url} -> ${response.status}`);
  const partial = `${binary}.partial`;
  await Bun.write(partial, response);
  if (!(await verified(partial, pinned.bytes, pinned.sha256))) {
    await rm(partial, { force: true });
    throw new Error(`agent-browser ${pin.version}: size or SHA-256 does not match the pin`);
  }
  await chmod(partial, 0o755);
  await rename(partial, binary);
  return binary;
}

if (import.meta.main) {
  const requested = process.argv.slice(2);
  const targets = requested.length > 0 ? requested : [...BROWSER_TARGETS];
  for (const target of targets) {
    if (!(BROWSER_TARGETS as readonly string[]).includes(target))
      throw new Error(`unknown target ${target}`);
    process.stdout.write(`${await fetchAgentBrowser(target as BrowserTarget)}\n`);
  }
}
