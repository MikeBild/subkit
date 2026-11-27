import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { signAssertion } from "../main/runner-key.ts";
import { command } from "../shared/local/runner-queue.fixture.ts";
import { ChannelError, createHttpChannel } from "./channel.ts";

const NOW = Date.parse("2026-11-21T10:00:00Z");
const ORIGIN = "https://subkit.example";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function fakeServer(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    const route = routes[`${call.method} ${new URL(call.url).pathname}`];
    return route ? route(call) : new Response(null, { status: 404 });
  }) as typeof fetch;
  return { calls, fetcher };
}

const token = () =>
  Response.json({
    access_token: "tok-1",
    expires_at: new Date(NOW + 10 * 60_000).toISOString(),
  });

describe("createHttpChannel", () => {
  test("exchanges a signed assertion for a token and reuses it", async () => {
    const keys = generateKeyPairSync("ed25519");
    const pem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const server = fakeServer({
      "POST /v1/device-runner/token": token,
      "POST /v1/device-runner/heartbeat": () => new Response(null, { status: 204 }),
    });
    const channel = createHttpChannel({
      origin: ORIGIN,
      deviceRunnerId: "r1",
      sign: async (assertion) => signAssertion(pem, assertion),
      fetch: server.fetcher,
      now: () => NOW,
      locale: "de",
      nonce: () => "n1",
    });
    const beat = {
      runner_version: "11.2.0",
      os: "darwin" as const,
      capabilities: ["files" as const],
      personal: [],
      permissions: {},
      allowances_digest: "d",
      generation: 2,
    };
    await channel.heartbeat(beat);
    await channel.heartbeat(beat);
    const tokenCalls = server.calls.filter((call) => call.url.endsWith("/token"));
    expect(tokenCalls).toHaveLength(1);
    const sent = JSON.parse(tokenCalls[0]?.body ?? "{}") as {
      assertion: string;
      signature: string;
    };
    expect(
      verify(
        null,
        Buffer.from(sent.assertion),
        keys.publicKey,
        Buffer.from(sent.signature, "base64url"),
      ),
    ).toBe(true);
    expect(server.calls[1]?.headers.authorization).toBe("Bearer tok-1");
    expect(server.calls[1]?.headers["accept-language"]).toBe("de");
  });

  test("reports a stop on the stop route", async () => {
    const server = fakeServer({
      "POST /v1/device-runner/token": token,
      "POST /v1/device-runner/stop": () => new Response(null, { status: 204 }),
    });
    const channel = createHttpChannel({
      origin: ORIGIN,
      deviceRunnerId: "r1",
      sign: async () => "sig",
      fetch: server.fetcher,
      now: () => NOW,
      locale: "de",
    });
    await channel.reportStop({ generation: 4, stopped_at: new Date(NOW).toISOString() });
    expect(JSON.parse(server.calls[1]?.body ?? "{}")).toEqual({
      generation: 4,
      stopped_at: "2026-11-21T10:00:00.000Z",
    });
    const failing = createHttpChannel({
      origin: ORIGIN,
      deviceRunnerId: "r1",
      sign: async () => "sig",
      fetch: fakeServer({ "POST /v1/device-runner/token": token }).fetcher,
      now: () => NOW,
      locale: "de",
    });
    await expect(
      failing.reportStop({ generation: 4, stopped_at: new Date(NOW).toISOString() }),
    ).rejects.toBeInstanceOf(ChannelError);
  });

  test("fails without a device key", async () => {
    const channel = createHttpChannel({
      origin: ORIGIN,
      deviceRunnerId: "r1",
      sign: async () => null,
      fetch: fakeServer({}).fetcher,
      now: () => NOW,
      locale: "de",
    });
    await expect(channel.progress("c1", "x")).rejects.toBeInstanceOf(ChannelError);
  });

  test("claims a command and rejects a mismatched one", async () => {
    const server = fakeServer({
      "POST /v1/device-runner/token": token,
      "POST /v1/device-runner/commands/c1/claim": () => Response.json(command("c1")),
      "POST /v1/device-runner/commands/c2/claim": () => Response.json(command("other")),
      "POST /v1/device-runner/commands/c3/claim": () => new Response(null, { status: 409 }),
    });
    const channel = createHttpChannel({
      origin: ORIGIN,
      deviceRunnerId: "r1",
      sign: async () => "sig",
      fetch: server.fetcher,
      now: () => NOW,
      locale: "de",
    });
    expect((await channel.claim("c1"))?.command_id).toBe("c1");
    expect(await channel.claim("c2")).toBeNull();
    expect(await channel.claim("c3")).toBeNull();
    const claim = server.calls.find((call) => call.url.endsWith("/c1/claim"));
    expect(claim?.body).toBeNull();
    expect(claim?.headers["content-type"]).toBeUndefined();
  });

  test("uploads an import through the runner upload routes", async () => {
    const upload = "0b0e9c1c-3f4f-4a59-9a3e-2f6f0a4f4a11";
    const chunks: { headers: Record<string, string>; method: string }[] = [];
    const server = fakeServer({
      "POST /v1/device-runner/token": token,
      "POST /v1/device-runner/uploads": () =>
        Response.json(
          { upload_id: upload, chunk_bytes_max: 4194304, expires_at: "2026-11-21T11:00:00.000Z" },
          { status: 201 },
        ),
      [`PUT /v1/device-runner/uploads/${upload}/chunks/0`]: (call) => {
        chunks.push(call);
        return Response.json({ received_bytes: 3 });
      },
      [`PUT /v1/device-runner/uploads/${upload}/chunks/1`]: () =>
        Response.json({ code: "chunk_conflict" }, { status: 409 }),
      [`POST /v1/device-runner/uploads/${upload}/commit`]: (call) =>
        Response.json({ file_id: JSON.parse(call.body ?? "{}").size === 3 ? "f" : "x" }),
      [`DELETE /v1/device-runner/uploads/${upload}`]: () => Response.json({ aborted: true }),
    });
    const channel = createHttpChannel({
      origin: ORIGIN,
      deviceRunnerId: "r1",
      sign: async () => "sig",
      fetch: server.fetcher,
      now: () => NOW,
      locale: "de",
    });
    expect(
      await channel.createUpload({ command_id: "a".repeat(64), name: "a", size: 3 }),
    ).toMatchObject({
      upload_id: upload,
    });
    await channel.putChunk(upload, 0, new Uint8Array([1, 2, 3]));
    expect(chunks[0]?.headers["content-type"]).toBe("application/octet-stream");
    await expect(channel.putChunk(upload, 1, new Uint8Array([4]))).rejects.toBeInstanceOf(
      ChannelError,
    );
    expect(await channel.commitUpload(upload, { sha256: "b".repeat(64), size: 3 })).toEqual({
      file_id: "f",
    });
    await channel.abortUpload(upload);
    expect(server.calls.at(-1)?.method).toBe("DELETE");
  });

  test("streams only id events", async () => {
    const body =
      'event: command.available\ndata: {"command_id":"c1"}\n\nevent: ping\ndata: {}\n\nevent: runner.revoked\ndata: {}\n\n';
    const server = fakeServer({
      "POST /v1/device-runner/token": token,
      "GET /v1/device-runner/stream": () => new Response(body),
    });
    const channel = createHttpChannel({
      origin: ORIGIN,
      deviceRunnerId: "r1",
      sign: async () => "sig",
      fetch: server.fetcher,
      now: () => NOW,
      locale: "de",
    });
    const events: unknown[] = [];
    await channel.stream((event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([
      { type: "command.available", command_id: "c1" },
      { type: "runner.revoked" },
    ]);
  });

  test("claims a secret ticket with the runner token and reads a gone ticket as none", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    let claims = 0;
    const server = fakeServer({
      "POST /v1/device-runner/token": token,
      [`POST /v1/device-runner/secret-tickets/${id}/claim`]: () => {
        claims += 1;
        return claims === 1
          ? Response.json({
              values: { username: "mike", password: "pw" },
              expires_at: new Date(NOW + 60_000).toISOString(),
            })
          : new Response(null, { status: 410 });
      },
    });
    const channel = createHttpChannel({
      origin: ORIGIN,
      deviceRunnerId: "r1",
      sign: async () => "sig",
      fetch: server.fetcher,
      now: () => NOW,
      locale: "en",
    });
    const values = await channel.claimSecretTicket(id);
    expect(values && Object.fromEntries(values)).toEqual({ username: "mike", password: "pw" });
    expect(server.calls.at(-1)?.headers.authorization).toBe("Bearer tok-1");
    expect(await channel.claimSecretTicket(id)).toBeNull();
  });
});
