import { VERSION } from "@cli-core/version.ts";
import { getConfig } from "../config/loader.ts";

export const SCRAPER_PROJECT_URL = "https://github.com/MikeBild/subkit";

export function scraperUserAgent(tenantId?: string, connectorOverride?: unknown): string {
  if (typeof connectorOverride === "string" && connectorOverride.trim().length > 0) {
    return connectorOverride;
  }
  const configured = getConfig(tenantId).connectors.web_scraper.runtime.user_agent.trim();
  if (configured.length > 0) return configured;
  const base = (getConfig().server.public_base_url ?? "").trim().replace(/\/+$/, "");
  const contact = base ? `${base}/bot` : SCRAPER_PROJECT_URL;
  return `subkit-web-scraper/${VERSION} (+${contact})`;
}
