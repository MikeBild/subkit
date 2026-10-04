import { debugLog } from "../debug.ts";
import type { EngineClient } from "../engine-client.ts";

const OAUTH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function hasCredential(client: EngineClient, connectorId: string): Promise<boolean> {
  const c = await client.getConnector(connectorId);
  return ((c as Record<string, unknown>).credential_count as number) > 0;
}

export async function runEngineOAuthFlow(
  client: EngineClient,
  connectorId: string,
  openBrowser: (url: string) => void,
): Promise<void> {
  const { authorization_url: oauth_url } = await client.startConnectorSignIn(connectorId);
  if (!oauth_url) return;
  const timeoutSignal = AbortSignal.timeout(OAUTH_TIMEOUT_MS);
  let resolveEvent!: (succeeded: boolean) => void;
  const eventArrived = new Promise<boolean>((resolve) => {
    resolveEvent = resolve;
  });
  timeoutSignal.addEventListener("abort", () => resolveEvent(false), { once: true });
  try {
    await client.subscribeConnectorOAuthCallback({
      connectorId,
      signal: timeoutSignal,
      onSucceeded: () => resolveEvent(true),
    });
  } catch (err) {
    debugLog(
      "oauth.sse_subscribe_failed",
      { connectorId, error: err instanceof Error ? err.message : String(err) },
      {},
    );
    openBrowser(oauth_url);
    while (!timeoutSignal.aborted) {
      await sleep(POLL_INTERVAL_MS);
      if (await hasCredential(client, connectorId)) return;
    }
    throw new Error("OAuth timed out — check your browser and try again");
  }
  openBrowser(oauth_url);
  if (await eventArrived) return;
  if (await hasCredential(client, connectorId)) return;
  throw new Error("OAuth timed out — check your browser and try again");
}
