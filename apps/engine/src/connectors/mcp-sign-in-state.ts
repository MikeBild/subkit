export const MCP_SIGN_IN_STATES = [
  "needs_sign_in",
  "registering",
  "awaiting_consent",
  "connected",
  "failed",
] as const;

export type McpSignInState = (typeof MCP_SIGN_IN_STATES)[number];

export type McpSignInEvent =
  | { type: "sign_in_started"; client_known: boolean }
  | { type: "client_registered" }
  | { type: "consent_granted" }
  | { type: "sign_in_failed" }
  | { type: "sign_in_reset" };

export type McpSignInStep =
  | { ok: true; from: McpSignInState; to: McpSignInState; event: McpSignInEvent["type"] }
  | {
      ok: false;
      from: McpSignInState;
      event: McpSignInEvent["type"];
      reason: "transition_not_allowed";
    };

export const MCP_SIGN_IN_PENDING_REASON = "sign_in_required";

type Guard = (event: McpSignInEvent) => McpSignInState;

const startSignIn: Guard = (event) =>
  event.type === "sign_in_started" && !event.client_known ? "registering" : "awaiting_consent";

const TRANSITIONS: Readonly<
  Record<McpSignInState, Readonly<Partial<Record<McpSignInEvent["type"], Guard>>>>
> = {
  needs_sign_in: { sign_in_started: startSignIn },
  registering: {
    client_registered: () => "awaiting_consent",
    sign_in_failed: () => "failed",
  },
  awaiting_consent: {
    sign_in_started: startSignIn,
    consent_granted: () => "connected",
    sign_in_failed: () => "failed",
  },
  connected: { sign_in_started: startSignIn, sign_in_reset: () => "needs_sign_in" },
  failed: { sign_in_started: startSignIn, sign_in_reset: () => "needs_sign_in" },
};

export function mcpSignInTransition(from: McpSignInState, event: McpSignInEvent): McpSignInStep {
  const guard = TRANSITIONS[from][event.type];
  return guard
    ? { ok: true, from, to: guard(event), event: event.type }
    : { ok: false, from, event: event.type, reason: "transition_not_allowed" };
}

export function mcpSignInStartSteps(
  from: McpSignInState,
  outcome: { registered_client: boolean },
): { ok: boolean; state: McpSignInState; path: McpSignInState[] } {
  const events: McpSignInEvent[] = outcome.registered_client
    ? [{ type: "sign_in_started", client_known: false }, { type: "client_registered" }]
    : [{ type: "sign_in_started", client_known: true }];
  return events.reduce<{ ok: boolean; state: McpSignInState; path: McpSignInState[] }>(
    (walk, event) => {
      if (!walk.ok) return walk;
      const step = mcpSignInTransition(walk.state, event);
      return step.ok
        ? { ok: true, state: step.to, path: [...walk.path, step.to] }
        : { ...walk, ok: false };
    },
    { ok: true, state: from, path: [from] },
  );
}

export function connectorSignsInInteractively(connector: {
  driver?: string | null;
  auth_type?: string | null;
}): boolean {
  return connector.driver === "mcp" && connector.auth_type === "oauth2";
}
