import type { PendingElicitation } from "@cli-core/index.ts";
import { useEffect } from "react";
import type { EngineClient } from "../engine-client.ts";

export function useOAuthAutoResume(
  pendingElicitation: PendingElicitation | null,
  engineClient: EngineClient | undefined,
  respond: (elicitationId: string, output: unknown, reason?: string) => Promise<void>,
): void {
  useEffect(() => {
    const pending = pendingElicitation;
    if (!pending || !engineClient) return undefined;
    if (pending.tool_name !== "ask_user_confirm") return undefined;
    const input = pending.input as
      | {
          kind?: unknown;
          target?: { tool?: unknown; args?: { connector_id?: unknown } };
        }
      | null
      | undefined;
    if (input?.kind !== "review_after_execution") return undefined;
    if (input.target?.tool !== "authenticate_oauth") return undefined;
    const connectorId =
      typeof input.target.args?.connector_id === "string" ? input.target.args.connector_id : null;
    if (!connectorId) return undefined;
    const ac = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const handle = await engineClient.subscribeConnectorOAuthCallback({
          connectorId,
          signal: ac.signal,
          onSucceeded: (payload) => {
            if (cancelled) return;
            void respond(
              pending.id,
              { confirmed: true },
              `OAuth callback succeeded for ${payload.connector_slug}`,
            );
          },
        });
        ac.signal.addEventListener("abort", () => handle.cancel(), { once: true });
      } catch {}
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingElicitation, engineClient]);
}
