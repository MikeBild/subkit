import { debugLog } from "../debug.ts";
import type { EngineClient } from "../engine-client.ts";

const OAUTH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function hasCredential(client: EngineClient, connectorId: string): Promise<boolean> {
  const c = await client.getConnector(connectorId);
  return ((c as Record<string, unknown>).credential_count as number) > 0;
}

/**
 * Drive a connector's browser OAuth flow and resolve the moment the
 * engine persists the credential. The completion signal is the
 * `connector.oauth.callback_succeeded` SSE event — subscribed BEFORE
 * the browser opens so a fast authorization cannot race the
 * subscription. A refused stream (proxy stripping SSE, filtered
 * endpoint) degrades to credential polling; a silently dropped stream
 * is covered by one final credential check at the timeout.
 */
export async function runEngineOAuthFlow(
  client: EngineClient,
  connectorId: string,
  openBrowser: (url: string) => void,
): Promise<void> {
  const { oauth_url } = await client.startConnectorOAuth(connectorId);
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
    // Degraded transport: the browser flow still works; poll the credential.
    openBrowser(oauth_url);
    while (!timeoutSignal.aborted) {
      await sleep(POLL_INTERVAL_MS);
      if (await hasCredential(client, connectorId)) return;
    }
    throw new Error("OAuth timed out — check your browser and try again", { cause: err });
  }
  // Subscription is live — safe to send the operator to the browser.
  openBrowser(oauth_url);
  if (await eventArrived) return;
  // Timeout or dropped stream: one final check covers a missed event.
  if (await hasCredential(client, connectorId)) return;
  throw new Error("OAuth timed out — check your browser and try again");
}
