import type { EngineClient } from "../engine-client.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runEngineOAuthFlow(
  client: EngineClient,
  connectorId: string,
  openBrowser: (url: string) => void,
): Promise<void> {
  const { oauth_url } = await client.startConnectorOAuth(connectorId);
  openBrowser(oauth_url);
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const c = await client.getConnector(connectorId);
    if (((c as Record<string, unknown>).credential_count as number) > 0) return;
  }
  throw new Error("OAuth timed out — check your browser and try again");
}
