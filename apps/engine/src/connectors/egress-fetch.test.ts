import { expect, mock, test } from "bun:test";
import { fetchWithEgressGuard } from "./egress-fetch.ts";

const strict = { mode: "strict" as const };
const start = "https://93.184.216.34/start";

test("validates a redirect target before another request is dispatched", async () => {
  const fetchImpl = mock(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      }),
  );
  await expect(
    fetchWithEgressGuard(start, {}, strict, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  ).rejects.toThrow();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("strict redirect DNS answers are checked at each hop", async () => {
  const fetchImpl = mock(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://rebind.example/private" },
      }),
  );
  await expect(
    fetchWithEgressGuard(start, {}, strict, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl: async () => [{ address: "10.0.0.1", family: 4 }],
    }),
  ).rejects.toThrow("private_ip_resolved");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("unresolved initial host never reaches the fetch implementation", async () => {
  const fetchImpl = mock(async () => new Response("unexpected"));
  await expect(
    fetchWithEgressGuard("https://unresolved.example/", {}, strict, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl: async () => {
        throw new Error("lookup failed");
      },
    }),
  ).rejects.toThrow("dns_resolution_failed");
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("cross-origin GET redirect drops all caller headers", async () => {
  const calls: RequestInit[] = [];
  const fetchImpl = mock(async (_url: URL | string | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://1.1.1.1/target" } })
      : new Response("done");
  });
  const response = await fetchWithEgressGuard(
    start,
    {
      headers: { authorization: "synthetic", "x-api-key": "synthetic", cookie: "synthetic" },
    },
    strict,
    { fetchImpl: fetchImpl as unknown as typeof fetch },
  );
  expect(await response.text()).toBe("done");
  expect(calls[0]?.redirect).toBe("manual");
  expect(Object.fromEntries(new Headers(calls[1]?.headers))).toEqual({ host: "1.1.1.1" });
});

test("manual authority boundary returns redirect without following it", async () => {
  const fetchImpl = mock(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      }),
  );
  const response = await fetchWithEgressGuard(start, { redirect: "manual" }, strict, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(response.status).toBe(302);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("refuses cross-origin body replay", async () => {
  const fetchImpl = mock(
    async () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://1.1.1.1/target" },
      }),
  );
  await expect(
    fetchWithEgressGuard(start, { method: "POST", body: "synthetic" }, strict, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  ).rejects.toThrow("redirect_cross_origin_body");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("caps a public redirect cycle", async () => {
  const fetchImpl = mock(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: start },
      }),
  );
  await expect(
    fetchWithEgressGuard(start, {}, strict, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  ).rejects.toThrow("redirect_limit");
  expect(fetchImpl).toHaveBeenCalledTimes(11);
});

test("permissive self-hosting retains original fetch redirect policy", async () => {
  const fetchImpl = mock(async () => new Response("private fixture"));
  await fetchWithEgressGuard(
    "http://localhost/",
    { redirect: "follow" },
    { mode: "permissive" },
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    },
  );
  expect(fetchImpl).toHaveBeenCalledWith("http://localhost/", { redirect: "follow" });
});

test("the socket target uses the checked answer while Host and TLS retain the logical origin", async () => {
  let lookups = 0;
  let target = "";
  let options: RequestInit & {
    tls?: { serverName?: string; rejectUnauthorized?: boolean };
    proxy?: unknown;
  } = {};
  const fetchImpl = async (input: URL | string | Request, init?: RequestInit) => {
    target = String(input);
    options = init ?? {};
    return new Response("done");
  };
  const response = await fetchWithEgressGuard(
    "https://origin.example.test:8443/path?x=1",
    {},
    strict,
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl: async () => {
        lookups += 1;
        return [{ address: lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
      },
    },
  );
  expect(lookups).toBe(1);
  expect(target).toBe("https://93.184.216.34:8443/path?x=1");
  expect(new Headers(options.headers).get("host")).toBe("origin.example.test:8443");
  expect(options.tls).toEqual({ serverName: "origin.example.test", rejectUnauthorized: true });
  expect(options.proxy).toBe(false);
  expect(response.url).toBe("https://origin.example.test:8443/path?x=1");
  expect(response.clone().url).toBe(response.url);
});

test("caller-specific socket, proxy and TLS options cannot bypass strict transport", async () => {
  let options: Record<string, unknown> = {};
  const fetchImpl = async (_input: unknown, init?: RequestInit) => {
    options = init as Record<string, unknown>;
    return new Response("done");
  };
  const init = {
    unix: "/tmp/unsafe-fixture.sock",
    proxy: "http://127.0.0.1:9000",
    session: {},
    tls: { rejectUnauthorized: false, serverName: "wrong.example" },
  };
  await fetchWithEgressGuard(start, init as RequestInit, strict, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(options.unix).toBeUndefined();
  expect(options.session).toBeUndefined();
  expect(options.proxy).toBe(false);
  expect(options.tls).toEqual({ serverName: "93.184.216.34", rejectUnauthorized: true });
});

test("mixed DNS answers are all checked before a preferred address is pinned", async () => {
  const fetchImpl = mock(async () => new Response("unexpected"));
  await expect(
    fetchWithEgressGuard("https://mixed.example.test", {}, strict, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "::1", family: 6 },
      ],
    }),
  ).rejects.toThrow("private_ip_resolved");
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("IPv6-only destinations are dialed as IP literals with their original Host", async () => {
  let target = "";
  const fetchImpl = async (url: URL | string | Request, init?: RequestInit) => {
    target = String(url);
    expect(new Headers(init?.headers).get("host")).toBe("ipv6.example.test");
    return new Response("done");
  };
  await fetchWithEgressGuard("https://ipv6.example.test/path", {}, strict, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    lookupImpl: async () => [{ address: "2606:4700:4700::1111", family: 6 }],
  });
  expect(target).toBe("https://[2606:4700:4700::1111]/path");
});
