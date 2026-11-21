import { describe, expect, test } from "bun:test";
import { api, fake, server, useConnectionsServer } from "./connections-flow-fixtures.ts";

useConnectionsServer();

describe("Kontoverbindungen → discovery and stray callbacks against a foreign OAuth 2.1 server", () => {
  test("discover says what is there, in words the page can show", async () => {
    const res = await api("/v1/connections/discover", {
      method: "POST",
      body: JSON.stringify({ base_url: `${fake.baseUrl}/` }),
    });
    expect(res.status).toBe(200);
    const discovered = (await res.json()) as {
      package: { id: string; version: string; artifacts: Record<string, unknown> } | null;
    };
    expect(discovered).toMatchObject({
      base_url: fake.baseUrl,
      connectable: true,
      reason: null,
      service_name: "Probe Service",
      service_version: "0.0.1",
      package_url: `${fake.baseUrl}/package.json`,
      issuer: fake.baseUrl,
      scopes_supported: ["read", "write", "admin"],
    });
    expect(discovered.package).toMatchObject({
      id: "com.subkit.support",
      version: "1.1.0",
    });
    expect(discovered.package).not.toHaveProperty("scripts");
  });

  test("discover names a server without registration as not connectable, not as broken", async () => {
    fake.registration = false;
    try {
      const res = await api("/v1/connections/discover", {
        method: "POST",
        body: JSON.stringify({ base_url: fake.baseUrl }),
      });
      expect(await res.json()).toMatchObject({
        connectable: false,
        reason: "registration_missing",
      });
    } finally {
      fake.registration = true;
    }
  });

  test("a callback without a state still ends on a page with a sentence", async () => {
    const landed = await fetch(`${server.baseUrl}/v1/connections/callback?code=x`, {
      redirect: "manual",
    });
    expect(landed.status).toBe(400);
    expect(await landed.text()).toContain("This link has expired or was already used.");
  });
});
