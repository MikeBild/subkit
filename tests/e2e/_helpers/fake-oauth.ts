// Tiny in-process Hono server simulating the engine's OAuth2 surface.
//
// Exposes:
//   GET  /oauth/poll/:state    — returns { status: "pending" | "complete" | "failed" }
//   POST /oauth/callback/:state — flips state to complete with a credential
//   POST /oauth/fail/:state    — flips state to failed
//
// Tests instantiate one server per case, drive the OAuthWaitView's
// poll callback against it, and shut it down on cleanup. Mirrors the
// engine's `/v1/credentials/oauth2/poll/:state` shape.

import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";

interface State {
  status: "pending" | "complete" | "failed";
  credential?: { id: string; [k: string]: unknown };
  error?: string;
}

export interface FakeOAuthServer {
  baseUrl: string;
  setState: (stateId: string, next: State) => void;
  /** Convenience: simulate an external callback completing a flow. */
  completeFlow: (stateId: string, credential: { id: string; [k: string]: unknown }) => void;
  failFlow: (stateId: string, error?: string) => void;
  /** Pollster the OAuthWaitView component can call directly. */
  buildPoll: (stateId: string) => () => Promise<{
    status: "pending" | "complete" | "failed";
    credential?: { id: string; [k: string]: unknown };
    error?: string;
  }>;
  cleanup: () => Promise<void>;
}

export async function startFakeOAuthServer(): Promise<FakeOAuthServer> {
  const map = new Map<string, State>();
  const app = new Hono();

  app.get("/oauth/poll/:state", (c) => {
    const stateId = c.req.param("state");
    const s = map.get(stateId) ?? { status: "pending" };
    return c.json(s);
  });

  app.post("/oauth/callback/:state", async (c) => {
    const stateId = c.req.param("state");
    const body = (await c.req.json().catch(() => ({}))) as {
      credential?: { id: string };
    };
    map.set(stateId, {
      status: "complete",
      credential: body.credential ?? { id: `cred-${stateId}` },
    });
    return c.json({ ok: true });
  });

  app.post("/oauth/fail/:state", async (c) => {
    const stateId = c.req.param("state");
    const body = (await c.req.json().catch(() => ({}))) as { error?: string };
    map.set(stateId, { status: "failed", error: body.error ?? "user_denied" });
    return c.json({ ok: true });
  });

  const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  const addr = (server as unknown as { address: () => { port: number } | null }).address();
  if (!addr || typeof addr !== "object") throw new Error("fake oauth server failed to bind");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    setState: (id, next) => map.set(id, next),
    completeFlow: (id, credential) => map.set(id, { status: "complete", credential }),
    failFlow: (id, error) => map.set(id, { status: "failed", error: error ?? "user_denied" }),
    buildPoll: (stateId) => async () => {
      const r = await fetch(`${baseUrl}/oauth/poll/${stateId}`);
      const body = (await r.json()) as State;
      return body.error !== undefined
        ? { status: body.status, error: body.error }
        : body.credential !== undefined
          ? { status: body.status, credential: body.credential }
          : { status: body.status };
    },
    cleanup: async () => {
      await new Promise<void>((resolve) => {
        (server as unknown as { close: (cb: () => void) => void }).close(() => resolve());
      });
    },
  };
}
