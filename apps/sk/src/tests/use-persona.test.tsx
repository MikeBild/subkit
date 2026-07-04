import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useEffect } from "react";
import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { usePersona } from "../repl/usePersona.ts";
import { flush, renderInk } from "./helpers/ink.tsx";

const PROFILE: ResolvedProfile = {
  name: "default",
  engine_url: "http://localhost:5050",
  api_key: "wf_live_test",
  active_tenant_id: "t-test",
  persona_hint: "operator",
  portal_locked: false,
};

interface BootstrapResp {
  whoami: {
    id: string;
    kind: "user";
    tenant_id: string;
    tenant_slug: string | null;
    email: string | null;
    role_name: string | null;
    provider: string;
    base_url: string | null;
    scopes: string[] | null;
  };
  permissions: string[];
  permissions_checked: string[];
  tenant: { id: string; slug: string | null; display_name: string | null };
  recent_sessions: Array<{ id: string; title: string | null; updated_at: string }>;
  flags: Record<string, boolean>;
  server_time: string;
}

class FakeClient {
  bootstrapCalls = 0;
  whoamiCalls = 0;
  rbacCalls = 0;
  skBootstrap(): Promise<BootstrapResp> {
    this.bootstrapCalls++;
    return Promise.resolve({
      whoami: {
        id: "u1",
        kind: "user",
        tenant_id: "t-test",
        tenant_slug: "t-test",
        email: "u@x",
        role_name: "operator",
        provider: "api_key",
        base_url: null,
        scopes: null,
      },
      permissions: ["conversation:read"],
      permissions_checked: ["conversation:read"],
      tenant: { id: "t-test", slug: "t-test", display_name: "T" },
      recent_sessions: [],
      flags: {},
      server_time: "2024-11-14T22:13:20.000Z", // FROZEN_NOW
    });
  }
  whoami(): Promise<{
    id: string;
    kind: "user";
    tenant_id: string;
    tenant_slug: string | null;
    email: string | null;
    role_name: string | null;
    provider: string;
  }> {
    this.whoamiCalls++;
    return Promise.resolve({
      id: "u1",
      kind: "user",
      tenant_id: "t-test",
      tenant_slug: "t-test",
      email: "u@x",
      role_name: "operator",
      provider: "api_key",
    });
  }
  rbacCan(): Promise<{ allow: boolean; source: string | null; reason: string | null }> {
    this.rbacCalls++;
    return Promise.resolve({ allow: false, source: null, reason: null });
  }
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "sk-use-persona-"));
});
afterEach(() => {
  try {
    rmSync(cacheDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function Probe({
  client,
  onState,
}: {
  client: EngineClient;
  onState: (s: { loading: boolean; allowed: string[] }) => void;
}): React.ReactElement | null {
  const r = usePersona(client, PROFILE, { cacheDir });
  useEffect(() => {
    onState({
      loading: r.loading,
      allowed: r.snapshot ? Array.from(r.snapshot.allowed) : [],
    });
  }, [r.loading, r.snapshot, onState]);
  return null;
}

describe("usePersona", () => {
  test("starts in `loading` then resolves with the bootstrap snapshot", async () => {
    const client = new FakeClient();
    const states: Array<{ loading: boolean; allowed: string[] }> = [];
    const ui = renderInk(
      <Probe client={client as unknown as EngineClient} onState={(s) => states.push(s)} />,
    );
    try {
      // Spin flush until the bootstrap microtask resolves; flush() is
      // the determinism-helper-equivalent setImmediate yield.
      for (let i = 0; i < 50 && (states.length === 0 || states[states.length - 1]?.loading); i++) {
        await flush();
      }
      const final = states[states.length - 1];
      expect(final?.loading).toBe(false);
      expect(final?.allowed).toContain("conversation:read");
      expect(client.bootstrapCalls).toBeGreaterThanOrEqual(1);
    } finally {
      ui.unmount();
    }
  });

  // R6-S4 review fix: re-render with a fresh `client` reference but
  // the same `(engine_url, tenant, fingerprint(api_key))` triple.
  // The hook's effect must NOT fire `loadBootstrap` a second time —
  // the `bootstrapKey` deps array (R5-W2) absorbs the identity
  // change and the disk cache returns the cached snapshot.
  test("re-rendering with a new client reference but same fingerprint reuses the cache", async () => {
    const clientA = new FakeClient();
    const clientB = new FakeClient();
    const ui = renderInk(<Probe client={clientA as unknown as EngineClient} onState={() => {}} />);
    try {
      for (let i = 0; i < 50 && clientA.bootstrapCalls === 0; i++) await flush();
      expect(clientA.bootstrapCalls).toBe(1);
      // Swap to a new client object — same engine_url + tenant +
      // api_key in PROFILE, so the same `bootstrapKey` resolves.
      ui.raw.rerender(<Probe client={clientB as unknown as EngineClient} onState={() => {}} />);
      // Yield a few microtasks; if the effect were going to re-fire,
      // it would do so synchronously after the rerender.
      for (let i = 0; i < 5; i++) await flush();
      expect(clientB.bootstrapCalls).toBe(0);
    } finally {
      ui.unmount();
    }
  });
});
