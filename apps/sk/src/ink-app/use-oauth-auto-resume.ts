// OAuth auto-resume (plan/read-sk-synthetic-wirth.md Fix #1).
//
// When the engine pauses on a `review_after_execution` elicitation
// for `authenticate_oauth`, the operator has just been handed an
// authorization URL and needs to complete the dance in a browser.
// Pre-fix the operator had to manually type "done" once the browser
// tab landed on the success page — no signal flowed back. Now the
// engine emits `connector.oauth.callback_succeeded` on the
// `connector.oauth` channel the instant the callback persists the
// credential, and this hook resolves the elicitation automatically.

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
    if (!input || input.kind !== "review_after_execution") return undefined;
    if (!input.target || input.target.tool !== "authenticate_oauth") return undefined;
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
      } catch {
        // Subscription couldn't open (transport error, auth failure).
        // The operator can still type "done" / approve manually; we
        // never want a missing auto-resume channel to block the flow.
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
    // `respond` (submitElicitationResponse) is a stable closure over
    // busyRef and session; listing it would force the effect to re-run
    // on every turn. Pending-elicitation id changes already trigger
    // the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingElicitation, engineClient]);
}
