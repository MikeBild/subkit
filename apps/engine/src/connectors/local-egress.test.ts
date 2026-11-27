import { describe, expect, test } from "bun:test";
import type { Executor } from "../db/client.ts";
import { guardedFetch } from "./egress-fetch.ts";
import {
  _withEgressLookupForTests,
  _withEgressTenantOriginForTests,
  assertEgressAllowedResolved,
  type EgressGuardContext,
  resolveAllowedEgressAddresses,
} from "./egress-guard.ts";
import {
  classifyLocalTarget,
  connectorLocalScope,
  localTlsOptions,
  ownTargetEntry,
} from "./local-egress.ts";

const exec = {} as Executor;

function localContext(
  baseUrl: string,
  mode: "strict" | "permissive" = "strict",
): EgressGuardContext {
  const scope = connectorLocalScope({ base_url: baseUrl });
  return { tenant_id: "tenant-local", exec, mode, ...(scope ? { local_mcp: scope } : {}) };
}

function asOrigin<T>(origin: "self_hosted" | "self_service", run: () => Promise<T>): Promise<T> {
  return _withEgressTenantOriginForTests(async () => origin, run);
}

describe("classifyLocalTarget", () => {
  test.each([
    ["http://localhost:8931/mcp", "loopback"],
    ["https://localhost:8443/", "loopback"],
    ["http://app.localhost:3000/", "loopback"],
    ["http://127.0.0.1:3000/", "loopback"],
    ["http://127.4.5.6/", "loopback"],
    ["http://[::1]:9000/", "loopback"],
    ["http://host.docker.internal:8931/mcp", "host_gateway"],
    ["http://gateway.docker.internal/", "host_gateway"],
    ["postgresql://localhost:5432/db", "loopback"],
    ["sftp://127.0.0.1:22/", "loopback"],
  ])("%s is %s", (url, expected) => {
    expect(classifyLocalTarget(url)).toBe(expected as "loopback" | "host_gateway");
  });

  test.each([
    "http://0.0.0.0:3000/",
    "http://[::]:3000/",
    "http://10.0.0.5/",
    "http://192.168.1.10/",
    "http://metadata.internal/",
    "https://api.example.com/",
    "file:///etc/passwd",
  ])("%s is not local", (url) => {
    expect(classifyLocalTarget(url)).toBeNull();
  });
});

describe("local connector egress", () => {
  const combos = [
    "http://localhost:8931/mcp",
    "https://localhost:8931/mcp",
    "http://127.0.0.1:8931/mcp",
    "https://127.0.0.1:8931/mcp",
    "http://[::1]:8931/mcp",
    "https://[::1]:8931/mcp",
  ];

  for (const mode of ["strict", "permissive"] as const) {
    for (const url of combos) {
      test(`${mode}: a self-hosted connector reaches its own address ${url}`, async () => {
        await asOrigin("self_hosted", () =>
          _withEgressLookupForTests(
            async () => [{ address: "127.0.0.1", family: 4 }],
            async () => {
              await expect(
                assertEgressAllowedResolved(url, localContext(url, mode)),
              ).resolves.toBeUndefined();
            },
          ),
        );
      });
    }
  }

  test("host.docker.internal may resolve to the Docker host gateway", async () => {
    const url = "http://host.docker.internal:8931/mcp";
    await asOrigin("self_hosted", () =>
      _withEgressLookupForTests(
        async () => [{ address: "192.168.65.254", family: 4 }],
        async () => {
          const addresses = await resolveAllowedEgressAddresses(url, localContext(url));
          expect(addresses).toEqual([{ address: "192.168.65.254", family: 4 }]);
        },
      ),
    );
  });

  test("a localhost name that resolves off the machine is refused", async () => {
    const url = "http://app.localhost:8931/mcp";
    await asOrigin("self_hosted", () =>
      _withEgressLookupForTests(
        async () => [{ address: "10.1.2.3", family: 4 }],
        async () => {
          await expect(resolveAllowedEgressAddresses(url, localContext(url))).rejects.toThrow(
            "local_name_resolved_elsewhere",
          );
        },
      ),
    );
  });

  test("a self-service workspace never reaches local addresses", async () => {
    const url = "http://127.0.0.1:8931/mcp";
    await asOrigin("self_service", async () => {
      await expect(
        assertEgressAllowedResolved(url, localContext(url, "permissive")),
      ).rejects.toThrow("private_ip_blocked");
    });
  });

  test("a remote connector is not granted local targets (302 to loopback)", async () => {
    const remote = connectorLocalScope({ base_url: "https://mcp.example.com/mcp" });
    expect(remote).toBeUndefined();
    await asOrigin("self_hosted", async () => {
      await expect(
        assertEgressAllowedResolved("http://127.0.0.1:8931/admin", {
          tenant_id: "tenant-local",
          exec,
          mode: "strict",
        }),
      ).rejects.toThrow("private_ip_blocked");
    });
  });

  test("a remote MCP server redirecting to loopback is refused on the redirect hop", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1:8931/" } });
    }) as unknown as typeof fetch;
    await asOrigin("self_hosted", () =>
      _withEgressLookupForTests(
        async () => [{ address: "93.184.216.34", family: 4 }],
        async () => {
          await expect(
            guardedFetch(
              { tenant_id: "tenant-local", exec, mode: "strict" },
              fetchImpl,
            )("https://mcp.example.com/mcp"),
          ).rejects.toThrow("private_ip_blocked");
        },
      ),
    );
    expect(calls).toHaveLength(1);
  });

  test("a local connector may not reach the Docker host gateway class", async () => {
    await asOrigin("self_hosted", async () => {
      await expect(
        assertEgressAllowedResolved(
          "http://host.docker.internal:8931/",
          localContext("http://127.0.0.1:8931/mcp"),
        ),
      ).rejects.toThrow("local_target_outside_connector");
    });
  });

  test("a local connector keeps the normal rules for private networks", async () => {
    await asOrigin("self_hosted", async () => {
      await expect(
        assertEgressAllowedResolved("http://10.0.0.5/", localContext("http://127.0.0.1:8931/mcp")),
      ).rejects.toThrow("private_ip_blocked");
    });
  });

  test("own-target scope covers database and file transfer connectors", () => {
    expect(ownTargetEntry("postgresql://localhost:5432/")).toEqual({
      local_mcp: { origin: "postgresql://localhost:5432/" },
    });
    expect(ownTargetEntry("postgresql://db.example.com:5432/")).toEqual({});
  });
});

describe("local TLS options", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

  test("apply only to https local targets", () => {
    const scope = connectorLocalScope({
      base_url: "https://localhost:8443/mcp",
      config: { mcp: { tls: { ca_pem: pem, skip_verify: true } } },
    });
    expect(localTlsOptions(new URL("https://localhost:8443/mcp"), scope)).toEqual({
      ca: pem,
      rejectUnauthorized: false,
    });
    expect(localTlsOptions(new URL("https://api.example.com/"), scope)).toBeNull();
    expect(localTlsOptions(new URL("http://localhost:8443/"), scope)).toBeNull();
  });

  test("read config.tls for HTTP connectors", () => {
    const scope = connectorLocalScope({
      base_url: "https://127.0.0.1:8443/",
      config: { tls: { ca_pem: pem } },
    });
    expect(localTlsOptions(new URL("https://127.0.0.1:8443/v1"), scope)).toEqual({ ca: pem });
  });

  test("are passed to the fetch in permissive mode", async () => {
    let seen: unknown;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      seen = (init as { tls?: unknown } | undefined)?.tls;
      return new Response("ok");
    }) as unknown as typeof fetch;
    const scope = connectorLocalScope({
      base_url: "https://localhost:8443/mcp",
      config: { mcp: { tls: { skip_verify: true } } },
    });
    await asOrigin("self_hosted", async () => {
      const response = await guardedFetch(
        {
          tenant_id: "tenant-local",
          exec,
          mode: "permissive",
          ...(scope ? { local_mcp: scope } : {}),
        },
        fetchImpl,
      )("https://localhost:8443/mcp");
      expect(await response.text()).toBe("ok");
    });
    expect(seen).toEqual({ rejectUnauthorized: false });
  });

  test("are passed to the pinned fetch in strict mode", async () => {
    let seen: unknown;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      seen = (init as { tls?: unknown } | undefined)?.tls;
      return new Response("ok");
    }) as unknown as typeof fetch;
    const scope = connectorLocalScope({
      base_url: "https://localhost:8443/mcp",
      config: { mcp: { tls: { skip_verify: true } } },
    });
    await asOrigin("self_hosted", () =>
      _withEgressLookupForTests(
        async () => [{ address: "127.0.0.1", family: 4 }],
        async () => {
          await guardedFetch(
            {
              tenant_id: "tenant-local",
              exec,
              mode: "strict",
              ...(scope ? { local_mcp: scope } : {}),
            },
            fetchImpl,
          )("https://localhost:8443/mcp");
        },
      ),
    );
    expect(seen).toEqual({ serverName: "localhost", rejectUnauthorized: false });
  });
});
